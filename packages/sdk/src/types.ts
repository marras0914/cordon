// ── Policy ────────────────────────────────────────────────────────────────────

export type PolicyAction =
  | 'allow'           // Pass through immediately
  | 'block'           // Reject, no forwarding
  | 'approve'         // Pause pending human approval
  | 'approve-writes'  // Reads pass, writes require approval
  | 'read-only'       // Block all write operations
  | 'log-only';       // Pass through but flag in audit log

export type ToolPolicy =
  | PolicyAction
  | { action: PolicyAction; reason?: string };

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
  /** Required for 'slack' and 'webhook' channels. */
  webhookUrl?: string;
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
