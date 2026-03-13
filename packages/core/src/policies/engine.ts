import type { PolicyAction, ResolvedConfig, ToolPolicy } from 'cordon-sdk';

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
    (w) => lower === w || lower.startsWith(`${w}_`) || lower.startsWith(`${w}-`) || lower.startsWith(w) && lower[w.length] === undefined,
  );
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

  evaluate(serverName: string, toolName: string): PolicyDecision {
    // Tool-level policy takes highest precedence
    const toolPolicy = this.toolPolicies.get(`${serverName}/${toolName}`);
    if (toolPolicy !== undefined) {
      return this.resolve(toolPolicy, toolName);
    }

    // Server-level policy (default: allow)
    const serverPolicy = this.serverPolicies.get(serverName) ?? 'allow';
    return this.resolve(serverPolicy, toolName);
  }

  private resolve(policy: ToolPolicy, toolName: string): PolicyDecision {
    const action = typeof policy === 'string' ? policy : policy.action;
    const customReason = typeof policy === 'object' ? policy.reason : undefined;

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
    }
  }
}
