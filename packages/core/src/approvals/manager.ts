import type { ApprovalConfig } from 'cordon-sdk';
import { TerminalApprovalChannel } from './terminal.js';

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
      case 'slack':
      case 'web':
      case 'webhook':
        // v2 — fall back to terminal with a warning
        process.stderr.write(
          `[cordon] warn: approval channel '${type}' not yet implemented, using terminal\n`,
        );
        return new TerminalApprovalChannel();
    }
  }
}
