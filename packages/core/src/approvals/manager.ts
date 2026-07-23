import type { ApprovalConfig } from '@getcordon/policy';
import { TerminalApprovalChannel } from './terminal.js';
import { SlackApprovalChannel } from './slack.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApprovalContext {
  callId: string;
  serverName: string;
  toolName: string;
  args: unknown;
  timeoutMs?: number;
}

export type ApprovalResult = { approved: true } | { approved: false; reason: string };

interface ApprovalChannel {
  request(ctx: ApprovalContext): Promise<ApprovalResult>;
}

// ── Manager ───────────────────────────────────────────────────────────────────

export class ApprovalManager {
  private channel: ApprovalChannel;
  private timeoutMs: number | undefined;

  constructor(config: ApprovalConfig | undefined) {
    this.timeoutMs = config?.timeoutMs;
    this.channel = this.buildChannel(config);
  }

  async request(ctx: Omit<ApprovalContext, 'timeoutMs'>): Promise<ApprovalResult> {
    return this.channel.request({ ...ctx, timeoutMs: this.timeoutMs });
  }

  private buildChannel(config: ApprovalConfig | undefined): ApprovalChannel {
    const type = config?.channel ?? 'terminal';
    switch (type) {
      case 'terminal':
        return new TerminalApprovalChannel();
      case 'slack': {
        // Slack posting is server-driven now — the local side only needs the
        // hosted endpoint + API key (auto-loaded from ~/.cordon/auth.json after
        // `cordon login`; see applyAuthDefaults in the CLI's start command).
        const { endpoint, apiKey } = config ?? {};
        if (!endpoint || !apiKey) {
          process.stderr.write(
            `[cordon] warn: slack channel requires a hosted endpoint + apiKey (run 'cordon login', or set audit.output to 'hosted') — falling back to terminal\n`,
          );
          return new TerminalApprovalChannel();
        }
        return new SlackApprovalChannel(endpoint, apiKey);
      }
      case 'web':
      case 'webhook':
        process.stderr.write(
          `[cordon] warn: approval channel '${type}' not yet implemented, using terminal\n`,
        );
        return new TerminalApprovalChannel();
    }
  }
}
