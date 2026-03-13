import type { AuditLogger } from '../audit/logger.js';
import type { ApprovalManager } from '../approvals/manager.js';
import type { PolicyEngine } from '../policies/engine.js';
import type { UpstreamManager, ToolCallResponse } from './upstream-manager.js';

/**
 * The hot path. Every tools/call from the LLM client flows through here.
 *
 * Flow:
 *   1. Resolve proxy tool name → server + original tool name
 *   2. Audit: received
 *   3. Evaluate policy → allow / block / approve
 *   4. If approve: await human decision
 *   5. Forward to upstream server
 *   6. Audit: completed
 *   7. Return result to LLM
 */
export class Interceptor {
  constructor(
    private upstream: UpstreamManager,
    private policy: PolicyEngine,
    private approvals: ApprovalManager,
    private audit: AuditLogger,
  ) {}

  async handle(proxyToolName: string, args: unknown): Promise<ToolCallResponse> {
    const tool = this.upstream.resolve(proxyToolName);
    if (!tool) {
      return errorResult(`Unknown tool: ${proxyToolName}`);
    }

    const callId = crypto.randomUUID();
    const { serverName, originalName } = tool;
    const start = Date.now();

    // 1. Audit
    this.audit.log({
      event: 'tool_call_received',
      callId,
      serverName,
      toolName: originalName,
      proxyName: proxyToolName,
      args,
    });

    // 2. Policy
    const decision = this.policy.evaluate(serverName, originalName);

    if (decision.action === 'block') {
      this.audit.log({
        event: 'tool_call_blocked',
        callId,
        serverName,
        toolName: originalName,
        reason: decision.reason,
      });
      return errorResult(decision.reason);
    }

    if (decision.action === 'approve') {
      this.audit.log({ event: 'approval_requested', callId, serverName, toolName: originalName });

      const result = await this.approvals.request({ callId, serverName, toolName: originalName, args });

      if (!result.approved) {
        this.audit.log({
          event: 'tool_call_denied',
          callId,
          serverName,
          toolName: originalName,
          reason: result.reason,
        });
        return errorResult(`Denied: ${result.reason}`);
      }

      this.audit.log({ event: 'tool_call_approved', callId, serverName, toolName: originalName });
    } else {
      this.audit.log({ event: 'tool_call_allowed', callId, serverName, toolName: originalName });
    }

    // 3. Forward to upstream
    try {
      const response = await this.upstream.callTool(serverName, originalName, args);
      this.audit.log({
        event: 'tool_call_completed',
        callId,
        serverName,
        toolName: originalName,
        isError: Boolean((response as { isError?: boolean }).isError),
        durationMs: Date.now() - start,
      });
      return response;
    } catch (err) {
      this.audit.log({
        event: 'tool_call_errored',
        callId,
        serverName,
        toolName: originalName,
        error: String(err),
        durationMs: Date.now() - start,
      });
      return errorResult(`Upstream error from '${serverName}': ${String(err)}`);
    }
  }
}

function errorResult(message: string): ToolCallResponse {
  return {
    content: [{ type: 'text', text: `[cordon] ${message}` }],
    isError: true,
  };
}
