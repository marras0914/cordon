import type { ApprovalContext, ApprovalResult } from './manager.js';

const POLL_INTERVAL_MS = 2000;

// Slack approvals are server-driven. The local proxy registers a pending
// approval with cordon-server (which posts the Block Kit card to the user's
// connected workspace using the workspace's stored bot token) and then polls
// for the decision. No bot token or channel lives in the local config — the
// user connects Slack once via "Add to Slack" in the dashboard, and the local
// config is just `approvals: { channel: 'slack' }`.
export class SlackApprovalChannel {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  async request(ctx: ApprovalContext): Promise<ApprovalResult> {
    // Register the pending approval. The server posts the Slack card; if it
    // can't (workspace not connected, no channel, Slack error) it returns a
    // non-2xx with a reason, and we fail the call rather than poll forever.
    try {
      const res = await fetch(`${this.endpoint}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cordon-Key': this.apiKey },
        body: JSON.stringify({
          callId: ctx.callId,
          toolName: ctx.toolName,
          serverName: ctx.serverName,
          args: ctx.args,
        }),
      });
      if (!res.ok) {
        let reason = `HTTP ${res.status}`;
        try {
          const data = (await res.json()) as { error?: string; reason?: string };
          reason = data.error ?? data.reason ?? reason;
        } catch {
          /* keep the status-code reason */
        }
        process.stderr.write(`[cordon] slack approval could not be routed: ${reason}\n`);
        return { approved: false, reason: `Slack approval unavailable: ${reason}` };
      }
    } catch (err) {
      const message = (err as Error).message;
      process.stderr.write(`[cordon] failed to register approval: ${message}\n`);
      return { approved: false, reason: `Failed to register approval with server: ${message}` };
    }

    process.stderr.write(
      `[cordon] approval requested via Slack for ${ctx.toolName} (call ${ctx.callId})\n`,
    );

    return this.poll(ctx);
  }

  private async poll(ctx: ApprovalContext): Promise<ApprovalResult> {
    const deadline = ctx.timeoutMs ? Date.now() + ctx.timeoutMs : Infinity;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      try {
        const res = await fetch(`${this.endpoint}/approvals/${ctx.callId}`, {
          headers: { 'X-Cordon-Key': this.apiKey },
        });
        if (!res.ok) continue;

        const data = (await res.json()) as { status: string };
        if (data.status === 'approved') {
          process.stderr.write(`[cordon] Slack approval granted for ${ctx.toolName}\n`);
          return { approved: true };
        }
        if (data.status === 'denied') {
          process.stderr.write(`[cordon] Slack approval denied for ${ctx.toolName}\n`);
          return { approved: false, reason: 'Denied via Slack' };
        }
      } catch {
        // network error — keep polling
      }
    }

    process.stderr.write(`[cordon] approval timed out for ${ctx.toolName}\n`);
    return { approved: false, reason: 'Approval timed out' };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
