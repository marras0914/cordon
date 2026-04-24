import type { PolicyAction, ResolvedConfig, ToolPolicy } from 'cordon-sdk';
import { classifySql } from './sql-classifier.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PolicyDecision =
  | { action: 'allow' }
  | { action: 'block'; reason: string }
  | { action: 'approve' };

// ── Write detection ───────────────────────────────────────────────────────────

// Tool names (or prefixes) that indicate a mutation/write operation.
const WRITE_PREFIXES = [
  'write',
  'create',
  'update',
  'delete',
  'remove',
  'drop',
  'insert',
  'execute',
  'exec',
  'run',
  'push',
  'post',
  'put',
  'patch',
  'set',
  'send',
  'deploy',
  'destroy',
  'reset',
  'clear',
  'purge',
  'truncate',
  'alter',
];

function isWriteOperation(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return WRITE_PREFIXES.some(
    (w) => lower === w || lower.startsWith(`${w}_`) || lower.startsWith(`${w}-`),
  );
}

/**
 * Extract the named SQL arg from a tool call's arguments object and
 * classify it. Returns `'unknown'` when the arg is missing or isn't a
 * string — SQL policies treat `'unknown'` as fail-closed.
 */
function classifyCallArg(args: unknown, sqlArg: string): 'read' | 'write' | 'unknown' {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'unknown';
  const value = (args as Record<string, unknown>)[sqlArg];
  if (typeof value !== 'string') return 'unknown';
  return classifySql(value);
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class PolicyEngine {
  /** server name → default policy action */
  private serverPolicies = new Map<string, PolicyAction>();
  /** "serverName/toolName" → tool-level policy */
  private toolPolicies = new Map<string, ToolPolicy>();

  constructor(config: ResolvedConfig) {
    for (const server of config.servers) {
      if (server.policy) {
        this.serverPolicies.set(server.name, server.policy);
      }
      for (const [toolName, policy] of Object.entries(server.tools ?? {})) {
        this.toolPolicies.set(`${server.name}/${toolName}`, policy);
      }
    }
  }

  /**
   * Evaluate a tool call. Pass `args` for policies that inspect tool-call
   * arguments (e.g. `sql-read-only`, `sql-approve-writes`). Omitting args
   * is fine for policies that don't consult them.
   */
  evaluate(serverName: string, toolName: string, args?: unknown): PolicyDecision {
    // Tool-level policy takes highest precedence
    const toolPolicy = this.toolPolicies.get(`${serverName}/${toolName}`);
    if (toolPolicy !== undefined) {
      return this.resolve(toolPolicy, toolName, args);
    }

    // Server-level policy (default: allow)
    const serverPolicy = this.serverPolicies.get(serverName) ?? 'allow';
    return this.resolve(serverPolicy, toolName, args);
  }

  /**
   * Returns true if this tool should be filtered out of the tools/list
   * response sent to the client. The gateway uses this to hide a tool
   * before the model can see it; the model can't be prompt-injected into
   * calling a tool it doesn't know exists. `evaluate()` will still block
   * the tool at call time as a failsafe.
   */
  isHidden(serverName: string, toolName: string): boolean {
    const toolPolicy = this.toolPolicies.get(`${serverName}/${toolName}`);
    if (toolPolicy !== undefined) {
      const action = typeof toolPolicy === 'string' ? toolPolicy : toolPolicy.action;
      return action === 'hidden';
    }
    return this.serverPolicies.get(serverName) === 'hidden';
  }

  private resolve(policy: ToolPolicy, toolName: string, args?: unknown): PolicyDecision {
    const action = typeof policy === 'string' ? policy : policy.action;
    const customReason = typeof policy === 'object' ? policy.reason : undefined;
    const sqlArg = typeof policy === 'object' ? policy.sqlArg ?? 'sql' : 'sql';

    switch (action) {
      case 'allow':
        return { action: 'allow' };

      case 'block':
        return {
          action: 'block',
          reason: customReason ?? `Tool '${toolName}' is blocked by policy`,
        };

      case 'approve':
        return { action: 'approve' };

      case 'read-only':
        return isWriteOperation(toolName)
          ? {
              action: 'block',
              reason:
                customReason ??
                `Read-only mode: '${toolName}' is a write operation and has been blocked`,
            }
          : { action: 'allow' };

      case 'approve-writes':
        return isWriteOperation(toolName) ? { action: 'approve' } : { action: 'allow' };

      case 'log-only':
        // Audit logger handles the flagging; call passes through
        return { action: 'allow' };

      case 'hidden':
        // Gateway filters these out of tools/list. If a call still reaches
        // the engine (client somehow knew the name), reject to fail secure.
        return {
          action: 'block',
          reason:
            customReason ??
            `Tool '${toolName}' is not exposed to clients (policy: hidden)`,
        };

      case 'sql-read-only': {
        const classification = classifyCallArg(args, sqlArg);
        if (classification === 'read') return { action: 'allow' };
        return {
          action: 'block',
          reason:
            customReason ??
            (classification === 'write'
              ? `SQL read-only policy: '${toolName}' received a non-SELECT statement; blocked`
              : `SQL read-only policy: '${toolName}' received unparseable SQL in arg '${sqlArg}'; blocked (fail-closed)`),
        };
      }

      case 'sql-approve-writes': {
        const classification = classifyCallArg(args, sqlArg);
        if (classification === 'read') return { action: 'allow' };
        if (classification === 'write') return { action: 'approve' };
        // Unparseable SQL: can't know what we'd be approving. Fail closed.
        return {
          action: 'block',
          reason:
            customReason ??
            `SQL approve-writes policy: '${toolName}' received unparseable SQL in arg '${sqlArg}'; blocked (fail-closed, nothing to approve)`,
        };
      }

      default:
        // Fail secure: block unknown policy actions rather than silently allowing
        return {
          action: 'block',
          reason: `Unknown policy action: ${String(action)}`,
        };
    }
  }
}
