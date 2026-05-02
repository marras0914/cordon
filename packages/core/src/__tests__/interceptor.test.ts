import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Interceptor } from '../proxy/interceptor.js';
import type { AuditLogger } from '../audit/logger.js';
import type { ApprovalManager } from '../approvals/manager.js';
import { PolicyEngine } from '../policies/engine.js';
import type { UpstreamManager } from '../proxy/upstream-manager.js';
import type { ResolvedConfig } from '@getcordon/sdk';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeUpstream(overrides: Partial<UpstreamManager> = {}): UpstreamManager {
  return {
    resolve: vi.fn().mockReturnValue({ serverName: 'db', originalName: 'read_data' }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    }),
    connect: vi.fn(),
    getTools: vi.fn().mockReturnValue([]),
    refreshRegistry: vi.fn(),
    ...overrides,
  } as unknown as UpstreamManager;
}

function makePolicy(action: 'allow' | 'block' | 'approve' = 'allow'): PolicyEngine {
  const decision =
    action === 'block'
      ? { action: 'block' as const, reason: 'blocked by policy' }
      : { action };
  return { evaluate: vi.fn().mockReturnValue(decision) } as unknown as PolicyEngine;
}

function makeApprovals(approved: boolean): ApprovalManager {
  return {
    request: vi.fn().mockResolvedValue(
      approved ? { approved: true } : { approved: false, reason: 'Denied by operator' }
    ),
  } as unknown as ApprovalManager;
}

function makeAudit(): AuditLogger {
  return { log: vi.fn(), close: vi.fn() } as unknown as AuditLogger;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Interceptor', () => {
  describe('unknown tool', () => {
    it('returns an error for an unresolvable tool name', async () => {
      const upstream = makeUpstream({ resolve: vi.fn().mockReturnValue(null) });
      const interceptor = new Interceptor(upstream, makePolicy(), makeApprovals(true), makeAudit());

      const result = await interceptor.handle('unknown_tool', {});
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Unknown tool');
    });
  });

  describe('allow policy', () => {
    it('forwards the call to upstream and returns the response', async () => {
      const upstream = makeUpstream();
      const interceptor = new Interceptor(upstream, makePolicy('allow'), makeApprovals(true), makeAudit());

      const result = await interceptor.handle('read_data', { table: 'users' });
      expect(result.isError).toBe(false);
      expect(upstream.callTool).toHaveBeenCalledWith('db', 'read_data', { table: 'users' });
    });

    it('does not call the approval manager', async () => {
      const approvals = makeApprovals(true);
      const interceptor = new Interceptor(makeUpstream(), makePolicy('allow'), approvals, makeAudit());
      await interceptor.handle('read_data', {});
      expect(approvals.request).not.toHaveBeenCalled();
    });
  });

  describe('block policy', () => {
    it('returns an error without calling upstream', async () => {
      const upstream = makeUpstream();
      const interceptor = new Interceptor(upstream, makePolicy('block'), makeApprovals(true), makeAudit());

      const result = await interceptor.handle('drop_table', {});
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('blocked by policy');
      expect(upstream.callTool).not.toHaveBeenCalled();
    });
  });

  describe('approve policy', () => {
    it('calls upstream when approved', async () => {
      const upstream = makeUpstream();
      const interceptor = new Interceptor(upstream, makePolicy('approve'), makeApprovals(true), makeAudit());

      const result = await interceptor.handle('write_file', { path: '/tmp/x' });
      expect(result.isError).toBe(false);
      expect(upstream.callTool).toHaveBeenCalled();
    });

    it('returns denied error without calling upstream when denied', async () => {
      const upstream = makeUpstream();
      const interceptor = new Interceptor(upstream, makePolicy('approve'), makeApprovals(false), makeAudit());

      const result = await interceptor.handle('write_file', { path: '/tmp/x' });
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Denied');
      expect(upstream.callTool).not.toHaveBeenCalled();
    });
  });

  describe('audit logging', () => {
    it('logs tool_call_received for every call', async () => {
      const audit = makeAudit();
      const interceptor = new Interceptor(makeUpstream(), makePolicy('allow'), makeApprovals(true), audit);
      await interceptor.handle('read_data', {});

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tool_call_received', toolName: 'read_data' })
      );
    });

    it('logs tool_call_blocked for blocked calls', async () => {
      const audit = makeAudit();
      const interceptor = new Interceptor(makeUpstream(), makePolicy('block'), makeApprovals(true), audit);
      await interceptor.handle('drop_table', {});

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tool_call_blocked' })
      );
    });

    it('logs approval_requested and tool_call_approved when approved', async () => {
      const audit = makeAudit();
      const interceptor = new Interceptor(makeUpstream(), makePolicy('approve'), makeApprovals(true), audit);
      await interceptor.handle('write_file', {});

      const events = (audit.log as ReturnType<typeof vi.fn>).mock.calls.map(
        (c: [{ event: string }]) => c[0].event
      );
      expect(events).toContain('approval_requested');
      expect(events).toContain('tool_call_approved');
    });

    it('logs tool_call_denied when denied', async () => {
      const audit = makeAudit();
      const interceptor = new Interceptor(makeUpstream(), makePolicy('approve'), makeApprovals(false), audit);
      await interceptor.handle('write_file', {});

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tool_call_denied' })
      );
    });

    it('logs tool_call_completed with durationMs on success', async () => {
      const audit = makeAudit();
      const interceptor = new Interceptor(makeUpstream(), makePolicy('allow'), makeApprovals(true), audit);
      await interceptor.handle('read_data', {});

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tool_call_completed', durationMs: expect.any(Number) })
      );
    });

    it('logs tool_call_errored when upstream throws', async () => {
      const upstream = makeUpstream({
        callTool: vi.fn().mockRejectedValue(new Error('upstream crash')),
      });
      const audit = makeAudit();
      const interceptor = new Interceptor(upstream, makePolicy('allow'), makeApprovals(true), audit);
      await interceptor.handle('read_data', {});

      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'tool_call_errored', error: expect.stringContaining('upstream crash') })
      );
    });
  });

  describe('upstream errors', () => {
    it('returns an error result when upstream throws', async () => {
      const upstream = makeUpstream({
        callTool: vi.fn().mockRejectedValue(new Error('connection refused')),
      });
      const interceptor = new Interceptor(upstream, makePolicy('allow'), makeApprovals(true), makeAudit());

      const result = await interceptor.handle('read_data', {});
      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('Upstream error');
    });
  });

  // ── Call-graph integration ────────────────────────────────────────────────────

  describe('call-graph integration', () => {
    function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
      return {
        servers: [
          { name: 'db',  transport: 'stdio', command: 'npx', args: [], policy: 'allow' },
          { name: 'net', transport: 'stdio', command: 'npx', args: [], policy: 'allow' },
        ],
        audit: { enabled: false },
        approvals: { channel: 'terminal' },
        ...overrides,
      };
    }

    function upstreamFor(serverName: string, originalName: string): UpstreamManager {
      return makeUpstream({
        resolve: vi.fn().mockReturnValue({ serverName, originalName }),
      });
    }

    it('end-to-end: db query → net post is blocked by a call-graph rule', async () => {
      const policy = new PolicyEngine(makeConfig({
        callGraph: [
          { from: 'query', to: 'post', action: 'block', reason: 'Exfil-shaped sequence.' },
        ],
      }));
      const audit = makeAudit();

      // Reuse a single Interceptor across two calls; resolve returns different (server, tool) per call.
      const upstream = makeUpstream({
        resolve: vi.fn()
          .mockReturnValueOnce({ serverName: 'db',  originalName: 'query' })
          .mockReturnValueOnce({ serverName: 'net', originalName: 'post' }),
      });
      const interceptor = new Interceptor(upstream, policy, makeApprovals(true), audit);

      const first = await interceptor.handle('query', {});
      expect(first.isError).toBe(false);

      const second = await interceptor.handle('post', { url: 'https://attacker.example.com' });
      expect(second.isError).toBe(true);
      const text = (second.content[0] as { text: string }).text;
      expect(text).toContain('Exfil-shaped sequence');
      // Upstream `post` was never called.
      expect(upstream.callTool).toHaveBeenCalledTimes(1);
      expect(upstream.callTool).toHaveBeenCalledWith('db', 'query', {});
    });

    it('lastToolName advances on successful call (subsequent call sees previousTool)', async () => {
      const policy = new PolicyEngine(makeConfig());
      const audit = makeAudit();
      const upstream = makeUpstream({
        resolve: vi.fn()
          .mockReturnValueOnce({ serverName: 'db', originalName: 'query' })
          .mockReturnValueOnce({ serverName: 'db', originalName: 'list' }),
      });
      const interceptor = new Interceptor(upstream, policy, makeApprovals(true), audit);

      await interceptor.handle('query', {});
      await interceptor.handle('list', {});

      const receivedEvents = (audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: [{ event: string; toolName?: string; previousTool?: string }]) => c[0])
        .filter((e: { event: string }) => e.event === 'tool_call_received');
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0].previousTool).toBeUndefined();
      expect(receivedEvents[1].previousTool).toBe('query');
    });

    it('lastToolName does NOT advance when call is blocked', async () => {
      const policy = new PolicyEngine(makeConfig({
        servers: [{
          name: 'fs', transport: 'stdio', command: 'npx', args: [],
          tools: { delete_file: 'block' },
        }],
      }));
      const audit = makeAudit();
      const upstream = makeUpstream({
        resolve: vi.fn()
          .mockReturnValueOnce({ serverName: 'fs', originalName: 'delete_file' })
          .mockReturnValueOnce({ serverName: 'fs', originalName: 'next_call' }),
      });
      const interceptor = new Interceptor(upstream, policy, makeApprovals(true), audit);

      await interceptor.handle('delete_file', {});
      await interceptor.handle('next_call', {});

      const receivedEvents = (audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: [{ event: string; previousTool?: string }]) => c[0])
        .filter((e: { event: string }) => e.event === 'tool_call_received');
      // Both received events should have previousTool=undefined: the blocked call didn't advance the chain.
      expect(receivedEvents[0].previousTool).toBeUndefined();
      expect(receivedEvents[1].previousTool).toBeUndefined();
    });

    it('lastToolName does NOT advance when approval is denied', async () => {
      const policy = new PolicyEngine(makeConfig({
        servers: [{
          name: 'srv', transport: 'stdio', command: 'npx', args: [], policy: 'approve',
        }],
      }));
      const audit = makeAudit();
      const upstream = makeUpstream({
        resolve: vi.fn()
          .mockReturnValueOnce({ serverName: 'srv', originalName: 'first' })
          .mockReturnValueOnce({ serverName: 'srv', originalName: 'second' }),
      });
      const approvals = makeApprovals(false); // denied
      const interceptor = new Interceptor(upstream, policy, approvals, audit);

      await interceptor.handle('first', {});
      await interceptor.handle('second', {});

      const receivedEvents = (audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: [{ event: string; previousTool?: string }]) => c[0])
        .filter((e: { event: string }) => e.event === 'tool_call_received');
      expect(receivedEvents[1].previousTool).toBeUndefined();
    });

    it('lastToolName does NOT advance when upstream throws', async () => {
      const policy = new PolicyEngine(makeConfig());
      const audit = makeAudit();
      const upstream = makeUpstream({
        resolve: vi.fn()
          .mockReturnValueOnce({ serverName: 'db', originalName: 'query' })
          .mockReturnValueOnce({ serverName: 'db', originalName: 'list' }),
        callTool: vi.fn()
          .mockRejectedValueOnce(new Error('upstream crash'))
          .mockResolvedValueOnce({ content: [{ type: 'text', text: 'ok' }], isError: false }),
      });
      const interceptor = new Interceptor(upstream, policy, makeApprovals(true), audit);

      await interceptor.handle('query', {}); // throws
      await interceptor.handle('list', {});

      const receivedEvents = (audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: [{ event: string; previousTool?: string }]) => c[0])
        .filter((e: { event: string }) => e.event === 'tool_call_received');
      expect(receivedEvents[1].previousTool).toBeUndefined();
    });

    it('audit log includes callGraphRule on blocked calls when a rule fires', async () => {
      const policy = new PolicyEngine(makeConfig({
        callGraph: [
          { from: 'query', to: 'post', action: 'block', reason: 'No outbound after queries.' },
        ],
      }));
      const audit = makeAudit();
      const upstream = makeUpstream({
        resolve: vi.fn()
          .mockReturnValueOnce({ serverName: 'db',  originalName: 'query' })
          .mockReturnValueOnce({ serverName: 'net', originalName: 'post' }),
      });
      const interceptor = new Interceptor(upstream, policy, makeApprovals(true), audit);

      await interceptor.handle('query', {});
      await interceptor.handle('post', {});

      const blockedEvent = (audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: [{ event: string; callGraphRule?: { from: string; to: string } }]) => c[0])
        .find((e: { event: string }) => e.event === 'tool_call_blocked');
      expect(blockedEvent).toBeDefined();
      expect(blockedEvent.callGraphRule).toEqual({ from: 'query', to: 'post' });
    });

    it('audit log includes callGraphRule on approval_requested when a rule fires', async () => {
      const policy = new PolicyEngine(makeConfig({
        callGraph: [
          { from: 'query', to: 'post', action: 'approve' },
        ],
      }));
      const audit = makeAudit();
      const upstream = makeUpstream({
        resolve: vi.fn()
          .mockReturnValueOnce({ serverName: 'db',  originalName: 'query' })
          .mockReturnValueOnce({ serverName: 'net', originalName: 'post' }),
      });
      const interceptor = new Interceptor(upstream, policy, makeApprovals(true), audit);

      await interceptor.handle('query', {});
      await interceptor.handle('post', {});

      const approvalEvent = (audit.log as ReturnType<typeof vi.fn>).mock.calls
        .map((c: [{ event: string; callGraphRule?: { from: string; to: string } }]) => c[0])
        .find((e: { event: string }) => e.event === 'approval_requested');
      expect(approvalEvent).toBeDefined();
      expect(approvalEvent.callGraphRule).toEqual({ from: 'query', to: 'post' });
    });
  });
});
