import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackApprovalChannel } from '../approvals/slack.js';
import type { ApprovalContext } from '../approvals/manager.js';

// Slack approvals are server-driven: the local channel registers a pending
// approval with cordon-server (which posts the Block Kit card) and polls for
// the decision. It no longer posts to Slack itself, so there is no bot token /
// channel / block-building here — those live server-side.

function makeCtx(overrides: Partial<ApprovalContext> = {}): ApprovalContext {
  return {
    callId: 'call-123',
    serverName: 'db',
    toolName: 'write_file',
    args: { path: '/tmp/x' },
    ...overrides,
  };
}

function makeChannel() {
  return new SlackApprovalChannel('https://cordon-server.test', 'crd_testapikey');
}

// cordon-server POST /approvals success (201)
function registerOkResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 201 });
}

// Poll response by status
function pollResponse(status: 'pending' | 'approved' | 'denied') {
  return new Response(JSON.stringify({ status }), { status: 200 });
}

describe('SlackApprovalChannel (server-driven)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe('approved', () => {
    it('registers then resolves approved when poll returns approved', async () => {
      fetchMock
        .mockResolvedValueOnce(registerOkResponse()) // POST /approvals
        .mockResolvedValueOnce(pollResponse('pending'))
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ approved: true });
    });

    it('sends callId, toolName, serverName, args to POST /approvals (no slack fields)', async () => {
      fetchMock
        .mockResolvedValueOnce(registerOkResponse())
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const ctx = makeCtx({ callId: 'call-abc', toolName: 'write_file', args: { path: '/x' } });
      const promise = channel.request(ctx);
      await vi.runAllTimersAsync();
      await promise;

      const [serverUrl, serverOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(serverUrl).toBe('https://cordon-server.test/approvals');
      expect(serverOpts.headers).toMatchObject({ 'X-Cordon-Key': 'crd_testapikey' });
      const body = JSON.parse(serverOpts.body as string);
      expect(body).toEqual({
        callId: 'call-abc',
        toolName: 'write_file',
        serverName: 'db',
        args: { path: '/x' },
      });
      // The local side must NOT send bot token / channel / ts anymore.
      expect(body.slackTs).toBeUndefined();
      expect(body.slackChannel).toBeUndefined();
    });

    it('polls GET /approvals/:callId with the correct URL and API key', async () => {
      fetchMock
        .mockResolvedValueOnce(registerOkResponse())
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx({ callId: 'call-xyz' }));
      await vi.runAllTimersAsync();
      await promise;

      const [pollUrl, pollOpts] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(pollUrl).toBe('https://cordon-server.test/approvals/call-xyz');
      expect((pollOpts.headers as Record<string, string>)['X-Cordon-Key']).toBe('crd_testapikey');
    });
  });

  describe('denied', () => {
    it('resolves not approved when poll returns denied', async () => {
      fetchMock
        .mockResolvedValueOnce(registerOkResponse())
        .mockResolvedValueOnce(pollResponse('denied'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ approved: false, reason: 'Denied via Slack' });
    });
  });

  describe('timeout', () => {
    it('resolves not approved after timeoutMs elapses with pending responses', async () => {
      fetchMock
        .mockResolvedValueOnce(registerOkResponse())
        .mockResolvedValue(pollResponse('pending'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx({ timeoutMs: 4000 }));
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ approved: false, reason: 'Approval timed out' });
    });
  });

  describe('resilience', () => {
    it('continues polling when a poll request throws a network error', async () => {
      fetchMock
        .mockResolvedValueOnce(registerOkResponse())
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ approved: true });
    });

    it('continues polling when a poll response is not ok', async () => {
      fetchMock
        .mockResolvedValueOnce(registerOkResponse())
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();

      expect(await promise).toEqual({ approved: true });
    });

    it('fails without polling when register throws (server unreachable)', async () => {
      fetchMock.mockRejectedValueOnce(new Error('server unreachable'));

      const channel = makeChannel();
      const result = await channel.request(makeCtx());

      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.reason).toContain('Failed to register approval with server');
        expect(result.reason).toContain('server unreachable');
      }
      // Only the register call happened — no polling.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fails with the server reason when register returns non-ok (e.g. Slack not connected)', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Slack not connected', reason: 'no_slack_install' }), { status: 409 }),
      );

      const channel = makeChannel();
      const result = await channel.request(makeCtx());

      expect(result.approved).toBe(false);
      if (!result.approved) {
        expect(result.reason).toContain('Slack approval unavailable');
        expect(result.reason).toContain('Slack not connected');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
