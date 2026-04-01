import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackApprovalChannel } from '../approvals/slack.js';
import type { ApprovalContext } from '../approvals/manager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  return new SlackApprovalChannel(
    'xoxb-test-token',
    '#cordon-approvals',
    'https://cordon-server.test',
    'crd_testapikey',
  );
}

// Successful Slack post response
function slackOkResponse(ts = '1234567890.000001', channel = 'C12345') {
  return new Response(JSON.stringify({ ok: true, ts, channel }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// cordon-server POST /approvals success
function serverOkResponse() {
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

// Poll response by status
function pollResponse(status: 'pending' | 'approved' | 'denied') {
  return new Response(JSON.stringify({ status }), { status: 200 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SlackApprovalChannel', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe('approved', () => {
    it('posts to Slack and cordon-server, then resolves approved when poll returns approved', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())   // chat.postMessage
        .mockResolvedValueOnce(serverOkResponse())  // POST /approvals
        .mockResolvedValueOnce(pollResponse('pending'))
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());

      // Advance past each 2s poll interval
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toEqual({ approved: true });
    });

    it('sends correct payload to Slack chat.postMessage', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx({ toolName: 'drop_table', serverName: 'db' }));
      await vi.runAllTimersAsync();
      await promise;

      const [slackUrl, slackOpts] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(slackUrl).toBe('https://slack.com/api/chat.postMessage');
      expect(slackOpts.headers).toMatchObject({ Authorization: 'Bearer xoxb-test-token' });
      const body = JSON.parse(slackOpts.body as string);
      expect(body.channel).toBe('#cordon-approvals');
      expect(body.text).toContain('drop_table');
      expect(body.text).toContain('db');
    });

    it('sends callId, toolName, serverName, args to POST /approvals', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse('ts1', 'C999'))
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const ctx = makeCtx({ callId: 'call-abc', toolName: 'write_file', args: { path: '/x' } });
      const promise = channel.request(ctx);
      await vi.runAllTimersAsync();
      await promise;

      const [serverUrl, serverOpts] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(serverUrl).toBe('https://cordon-server.test/approvals');
      expect(serverOpts.headers).toMatchObject({ 'X-Cordon-Key': 'crd_testapikey' });
      const body = JSON.parse(serverOpts.body as string);
      expect(body.callId).toBe('call-abc');
      expect(body.toolName).toBe('write_file');
      expect(body.slackTs).toBe('ts1');
      expect(body.slackChannel).toBe('C999');
    });

    it('polls GET /approvals/:callId with the correct URL and API key', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx({ callId: 'call-xyz' }));
      await vi.runAllTimersAsync();
      await promise;

      const [pollUrl, pollOpts] = fetchMock.mock.calls[2] as [string, RequestInit];
      expect(pollUrl).toBe('https://cordon-server.test/approvals/call-xyz');
      expect((pollOpts.headers as Record<string, string>)['X-Cordon-Key']).toBe('crd_testapikey');
    });

    it('block_id on the actions block is the callId', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx({ callId: 'call-blockid' }));
      await vi.runAllTimersAsync();
      await promise;

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      const actionsBlock = body.blocks.find((b: { type: string }) => b.type === 'actions');
      expect(actionsBlock.block_id).toBe('call-blockid');
    });
  });

  // ── Denied ──────────────────────────────────────────────────────────────────

  describe('denied', () => {
    it('resolves not approved when poll returns denied', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValueOnce(pollResponse('denied'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();
      await promise;

      const result = await promise;
      expect(result).toEqual({ approved: false, reason: 'Denied via Slack' });
    });
  });

  // ── Timeout ─────────────────────────────────────────────────────────────────

  describe('timeout', () => {
    it('resolves not approved after timeoutMs elapses with pending responses', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValue(pollResponse('pending'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx({ timeoutMs: 4000 }));
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toEqual({ approved: false, reason: 'Approval timed out' });
    });
  });

  // ── Resilience ──────────────────────────────────────────────────────────────

  describe('resilience', () => {
    it('continues polling when a poll request throws a network error', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toEqual({ approved: true });
    });

    it('continues polling when a poll response is not ok', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toEqual({ approved: true });
    });

    it('returns denied if POST /approvals fails (cannot track the call)', async () => {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockRejectedValueOnce(new Error('server unreachable'));

      const channel = makeChannel();
      const result = await channel.request(makeCtx());
      expect(result).toEqual({ approved: false, reason: 'Failed to register approval with server' });
    });

    it('still creates approval record even when Slack post fails', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('slack down'))  // Slack fails
        .mockResolvedValueOnce(serverOkResponse())       // server record still created
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx());
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toEqual({ approved: true });
      // Confirm server was called despite Slack failure
      const serverCall = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(serverCall[0]).toBe('https://cordon-server.test/approvals');
    });
  });

  // ── Block Kit structure ──────────────────────────────────────────────────────

  describe('block kit message', () => {
    async function getBlocks(overrides: Partial<ApprovalContext> = {}) {
      fetchMock
        .mockResolvedValueOnce(slackOkResponse())
        .mockResolvedValueOnce(serverOkResponse())
        .mockResolvedValueOnce(pollResponse('approved'));

      vi.useFakeTimers();
      const channel = makeChannel();
      const promise = channel.request(makeCtx(overrides));
      await vi.runAllTimersAsync();
      await promise;

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      return body.blocks as Array<{ type: string; block_id?: string; elements?: Array<{ action_id: string; value: string }> }>;
    }

    it('includes header, two section blocks, and an actions block', async () => {
      const blocks = await getBlocks();
      const types = blocks.map((b) => b.type);
      expect(types).toContain('header');
      expect(types.filter((t) => t === 'section')).toHaveLength(2);
      expect(types).toContain('actions');
    });

    it('actions block has approve and deny buttons', async () => {
      const blocks = await getBlocks();
      const actions = blocks.find((b) => b.type === 'actions');
      const actionIds = actions?.elements?.map((e) => e.action_id);
      expect(actionIds).toContain('approve');
      expect(actionIds).toContain('deny');
    });

    it('approve button has value "approve" and deny has value "deny"', async () => {
      const blocks = await getBlocks();
      const actions = blocks.find((b) => b.type === 'actions');
      const approve = actions?.elements?.find((e) => e.action_id === 'approve');
      const deny = actions?.elements?.find((e) => e.action_id === 'deny');
      expect(approve?.value).toBe('approve');
      expect(deny?.value).toBe('deny');
    });
  });
});
