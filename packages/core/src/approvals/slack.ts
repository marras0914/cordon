import type { ApprovalContext, ApprovalResult } from './manager.js';

const POLL_INTERVAL_MS = 2000;

export class SlackApprovalChannel {
  constructor(
    private readonly botToken: string,
    private readonly channel: string,
    private readonly endpoint: string,
    private readonly apiKey: string,
  ) {}

  async request(ctx: ApprovalContext): Promise<ApprovalResult> {
    // Post Slack message first. If this fails, there's nothing to click —
    // fail the approval immediately instead of polling for the timeout.
    let slackTs: string | undefined;
    let slackChannelId: string | undefined;

    try {
      const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.botToken}`,
        },
        body: JSON.stringify({
          channel: this.channel,
          text: `⚠ Approval required: *${ctx.toolName}* on \`${ctx.serverName}\``,
          blocks: this.buildBlocks(ctx),
        }),
      });

      const msgData = (await msgRes.json()) as {
        ok: boolean;
        ts?: string;
        channel?: string;
        error?: string;
      };

      if (msgData.ok) {
        slackTs = msgData.ts;
        slackChannelId = msgData.channel;
      } else {
        const err = msgData.error ?? 'unknown';
        const hint = slackErrorHint(err, this.channel);
        process.stderr.write(`[cordon] slack post failed: ${err}${hint ? ' — ' + hint : ''}\n`);
        return {
          approved: false,
          reason: `Slack approval request failed: ${err}${hint ? ' (' + hint + ')' : ''}`,
        };
      }
    } catch (err) {
      const message = (err as Error).message;
      process.stderr.write(`[cordon] slack post error: ${message}\n`);
      return {
        approved: false,
        reason: `Cannot reach Slack to request approval: ${message}`,
      };
    }

    // Create pending approval record on cordon-server
    try {
      await fetch(`${this.endpoint}/approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cordon-Key': this.apiKey },
        body: JSON.stringify({
          callId: ctx.callId,
          toolName: ctx.toolName,
          serverName: ctx.serverName,
          args: ctx.args,
          slackChannel: slackChannelId,
          slackTs,
        }),
      });
    } catch (err) {
      process.stderr.write(`[cordon] failed to register approval: ${(err as Error).message}\n`);
      return { approved: false, reason: 'Failed to register approval with server' };
    }

    process.stderr.write(
      `[cordon] approval requested via Slack for ${ctx.toolName} (call ${ctx.callId})\n`,
    );

    // Poll for response
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

        const data = await res.json() as { status: string };
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

  private buildBlocks(ctx: ApprovalContext): unknown[] {
    const argsText = ctx.args != null
      ? '```' + JSON.stringify(ctx.args, null, 2) + '```'
      : '_no args_';

    return [
      {
        type: 'header',
        text: { type: 'plain_text', text: '⚠ Approval Required', emoji: true },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Server:*\n${ctx.serverName}` },
          { type: 'mrkdwn', text: `*Tool:*\n${ctx.toolName}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Args:*\n${argsText}` },
      },
      {
        type: 'actions',
        block_id: ctx.callId,
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '✓ Approve', emoji: true },
            style: 'primary',
            value: 'approve',
            action_id: 'approve',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '✗ Deny', emoji: true },
            style: 'danger',
            value: 'deny',
            action_id: 'deny',
          },
        ],
      },
    ];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function slackErrorHint(error: string, channel: string): string {
  switch (error) {
    case 'not_in_channel':
      return `invite the bot to ${channel} with /invite @<bot-name>`;
    case 'channel_not_found':
      return `channel ${channel} does not exist or the bot can't see it`;
    case 'invalid_auth':
    case 'not_authed':
    case 'token_revoked':
    case 'token_expired':
      return 'bot token is invalid or expired — re-issue from the Slack app dashboard';
    case 'missing_scope':
      return "bot needs 'chat:write' scope (OAuth & Permissions → Bot Token Scopes, then Reinstall to Workspace)";
    case 'rate_limited':
      return 'Slack rate limit — retry shortly';
    default:
      return '';
  }
}
