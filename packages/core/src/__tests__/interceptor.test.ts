import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Interceptor } from '../proxy/interceptor.js';
import type { AuditLogger } from '../audit/logger.js';
import type { ApprovalManager } from '../approvals/manager.js';
import type { PolicyEngine } from '../policies/engine.js';
import type { UpstreamManager } from '../proxy/upstream-manager.js';

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
});
