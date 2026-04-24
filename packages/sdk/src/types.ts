// ── Policy ────────────────────────────────────────────────────────────────────

export type PolicyAction =
  | 'allow'              // Pass through immediately
  | 'block'              // Reject, no forwarding
  | 'approve'            // Pause pending human approval
  | 'approve-writes'     // Reads pass, writes require approval (tool-name heuristic)
  | 'read-only'          // Block all write operations (tool-name heuristic)
  | 'log-only'           // Pass through but flag in audit log
  | 'hidden'             // Filter from tools/list AND block at call time
  | 'sql-read-only'      // Parse the SQL arg, block anything that isn't SELECT (fail-closed on unparseable)
  | 'sql-approve-writes'; // Parse the SQL arg; SELECT passes, writes require approval, unparseable blocks

export type ToolPolicy =
  | PolicyAction
  | {
      action: PolicyAction;
      /** Custom message returned to the agent when this policy blocks a call. */
      reason?: string;
      /**
       * For `sql-read-only` / `sql-approve-writes` only: the argument name
       * containing the SQL text. Defaults to `'sql'`.
       */
      sqlArg?: string;
    };

// ── Server config ─────────────────────────────────────────────────────────────

export interface StdioServerConfig {
  /** Identifier used in audit logs, tool namespacing, and policy keys. */
  name: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Default policy for all tools on this server.
   * @default 'allow'
   */
  policy?: PolicyAction;
  /**
   * Per-tool overrides. Key is the bare tool name (no namespace).
   * @example { 'execute': 'approve', 'query': 'allow', 'delete': 'block' }
   */
  tools?: Record<string, ToolPolicy>;
  /**
   * Explicit list of tool names this server is expected to advertise. When
   * set, Cordon treats any upstream tool NOT in this list (and not keyed in
   * `tools`) as "unknown" and applies `onUnknownTool`. Lets operators
   * opt into a closed-world view of the upstream's tool surface so that a
   * new tool added in a future upstream release doesn't silently become
   * callable.
   *
   * Use `cordon discover` to populate this from the live upstream on
   * first setup (coming in a future release).
   *
   * Leave undefined to disable the check entirely (backwards compatible).
   */
  knownTools?: string[];
  /**
   * What to do when an upstream advertises a tool that isn't in `knownTools`
   * or `tools`. `'block'` drops it from tools/list (and from the registry,
   * so it can't be called). `'allow'` exposes it under the server-level
   * policy, with a stderr warning so the operator knows to add it.
   * Only takes effect when `knownTools` is set.
   * @default 'block'
   */
  onUnknownTool?: 'allow' | 'block';
}

export type ServerConfig = StdioServerConfig;

// ── Approval ──────────────────────────────────────────────────────────────────

export type ApprovalChannelType = 'terminal' | 'slack' | 'web' | 'webhook';

export interface ApprovalConfig {
  /**
   * Where approval requests are sent.
   * @default 'terminal'
   */
  channel?: ApprovalChannelType;
  /**
   * Milliseconds before an unanswered approval is auto-denied.
   * Omit for no timeout.
   */
  timeoutMs?: number;
  /** Slack bot token (xoxb-...). Required when channel is 'slack'. */
  slackBotToken?: string;
  /** Slack channel to post approval requests to (e.g. '#cordon-approvals'). Required when channel is 'slack'. */
  slackChannel?: string;
  /** Cordon server endpoint for approval polling. Required when channel is 'slack'. */
  endpoint?: string;
  /** API key for the Cordon server. Required when channel is 'slack'. */
  apiKey?: string;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export type AuditOutputType = 'stdout' | 'file' | 'hosted' | 'otlp' | 'webhook';

export interface AuditConfig {
  enabled: boolean;
  /** One or more output destinations. */
  output?: AuditOutputType | AuditOutputType[];
  /** File path when output includes 'file'. @default './cordon-audit.log' */
  filePath?: string;
  /** Endpoint when output includes 'webhook' or 'otlp'. */
  webhookUrl?: string;
  /** Cordon hosted receiver URL. Required when output includes 'hosted'. */
  endpoint?: string;
  /** API key for the hosted receiver (X-Cordon-Key header). Required when output includes 'hosted'. */
  apiKey?: string;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Max tool calls per minute across all servers. */
  maxCallsPerMinute: number;
  /** Per-server overrides (server name → calls/min). */
  perServer?: Record<string, number>;
  /** Per-tool overrides (bare tool name → calls/min). */
  perTool?: Record<string, number>;
  onExceeded: 'block' | 'queue';
}

// ── Top-level config ──────────────────────────────────────────────────────────

export interface CordonConfig {
  servers: ServerConfig[];
  audit?: AuditConfig;
  approvals?: ApprovalConfig;
  /** Rate limiting — v2 feature, stubbed for now. */
  rateLimit?: RateLimitConfig;
}

// ── Resolved config (internal) ────────────────────────────────────────────────

/** Config after validation and defaults are applied. */
export type ResolvedConfig = Required<Pick<CordonConfig, 'servers'>> &
  Omit<CordonConfig, 'servers'>;
