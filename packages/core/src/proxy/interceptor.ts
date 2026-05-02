import type { AuditLogger } from '../audit/logger.js';
import type { ApprovalManager } from '../approvals/manager.js';
import type { PolicyEngine } from '../policies/engine.js';
import type { UpstreamManager, ToolCallResponse } from './upstream-manager.js';
import type { RateLimiter } from '../rate-limiter.js';

/**
 * The hot path. Every tools/call from the LLM client flows through here.
 *
 * Flow:
 *   1. Resolve proxy tool name → server + original tool name
 *   2. Audit: received (with previousTool context for call-graph analysis)
 *   3. Rate limit check → block if exceeded
 *   4. Evaluate policy (with lastToolName for call-graph rules) → allow / block / approve
 *   5. If approve: await human decision
 *   6. Forward to upstream server
 *   7. On successful return: update lastToolName (chain advances)
 *   8. Audit: completed
 *   9. Return result to LLM
 *
 * `lastToolName` is updated only after the upstream call returns without a thrown
 * error. Blocked, denied, or transport-failed calls do not advance the chain. This
 * is a v1 trade-off — a probing adversary can attempt blocked calls without
 * "poisoning" subsequent evaluations. Documented in `tier1-per-agent-policies.md`.
 */
export class Interceptor {
  /** The previously-executed tool name (bare, not namespaced). `undefined` until the first successful call. */
  private lastToolName: string | undefined;

  constructor(
    private upstream: UpstreamManager,
    private policy: PolicyEngine,
    private approvals: ApprovalManager,
    private audit: AuditLogger,
    private rateLimiter?: RateLimiter,
  ) {}

  async handle(proxyToolName: string, args: unknown): Promise<ToolCallResponse> {
    const tool = this.upstream.resolve(proxyToolName);
    if (!tool) {
      return errorResult(`Unknown tool: ${proxyToolName}`);
    }

    const callId = crypto.randomUUID();
    const { serverName, originalName } = tool;
    const start = Date.now();
    const previousTool = this.lastToolName;

    // 1. Audit
    this.audit.log({
      event: 'tool_call_received',
      callId,
      serverName,
      toolName: originalName,
      proxyName: proxyToolName,
      args,
      previousTool,
    });

    // 2. Rate limit
    if (this.rateLimiter && !this.rateLimiter.check(serverName, originalName)) {
      this.audit.log({
        event: 'tool_call_blocked',
        callId,
        serverName,
        toolName: originalName,
        reason: 'Rate limit exceeded',
        previousTool,
      });
      return errorResult('Rate limit exceeded');
    }

    // 3. Policy — args drive sql-* policies, lastToolName drives call-graph rules
    const decision = this.policy.evaluate(serverName, originalName, args, this.lastToolName);

    if (decision.action === 'block') {
      this.audit.log({
        event: 'tool_call_blocked',
        callId,
        serverName,
        toolName: originalName,
        reason: decision.reason,
        previousTool,
        callGraphRule: decision.callGraph,
      });
      return errorResult(decision.reason);
    }

    if (decision.action === 'approve') {
      this.audit.log({
        event: 'approval_requested',
        callId,
        serverName,
        toolName: originalName,
        previousTool,
        callGraphRule: decision.callGraph,
      });

      const result = await this.approvals.request({ callId, serverName, toolName: originalName, args });

      if (!result.approved) {
        this.audit.log({
          event: 'tool_call_denied',
          callId,
          serverName,
          toolName: originalName,
          reason: result.reason,
          previousTool,
        });
        return errorResult(`Denied: ${result.reason}`);
      }

      this.audit.log({ event: 'tool_call_approved', callId, serverName, toolName: originalName, previousTool });
    } else {
      this.audit.log({ event: 'tool_call_allowed', callId, serverName, toolName: originalName, previousTool });
    }

    // 4. Forward to upstream
    try {
      const response = await this.upstream.callTool(serverName, originalName, args);
      // Chain advances only on a clean upstream return (success or upstream-reported isError).
      // Thrown errors below do NOT advance — we don't know what happened on the wire.
      this.lastToolName = originalName;
      this.audit.log({
        event: 'tool_call_completed',
        callId,
        serverName,
        toolName: originalName,
        isError: Boolean((response as { isError?: boolean }).isError),
        durationMs: Date.now() - start,
        previousTool,
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
        previousTool,
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
