# System Patterns

> [!WARNING]
> **Historical snapshot — superseded, do not trust for current status.**
> This file was last updated **2026-03-14** and describes an early "Month 1 / Month 2"
> phase of the project. Several statements here are now simply wrong: rate limiting
> shipped, the hosted backend has been deployed at `app.getcordon.com` since May 2026,
> and the project was renamed **Cordon for MCP**.
>
> For current information use:
> - [`README.md`](../README.md) — features, policies, quickstart, roadmap
> - [`CLAUDE.md`](../CLAUDE.md) — architecture, conventions, published versions, gotchas
>
> Kept only as a record of early design intent.

## Core Architecture: Aggregator Proxy

One Cordon process presents a single MCP server to Claude Desktop and internally manages N child MCP processes.

```
Claude Desktop ──stdio──▶ CordonGateway ──stdio──▶ [MCP server A]
                                         ──stdio──▶ [MCP server B]
```

Claude Desktop's config has ONE entry pointing at Cordon. `cordon init` patches the existing config automatically.

**Why aggregator over per-server proxy:**
- Approval state lives in one process — no IPC needed
- Single config entry for the user
- Cross-server policy enforcement is possible
- Cordon owns the full tool namespace

## The Hot Path

Every `tools/call` from the LLM flows through `Interceptor.handle()`:

```
tools/call received
  → resolve proxyToolName → serverName + originalName
  → audit: tool_call_received
  → PolicyEngine.evaluate(serverName, toolName) → allow | block | approve
  → if block: audit + return error immediately
  → if approve: audit + await ApprovalManager.request() [blocks here]
      → if denied: audit + return error
      → if approved: audit + continue
  → forward to upstream via UpstreamManager.callTool()
  → audit: tool_call_completed
  → return response to LLM
```

## Critical: stdio Ownership

`process.stdin` and `process.stdout` belong to the MCP transport. Writing anything to stdout or reading from stdin corrupts the JSON-RPC stream silently.

**Rule:** Everything else — audit logs, approval UI, debug output — goes to `process.stderr`.

The terminal approval channel reads human input from `/dev/tty` (Unix) or `\\.\CONIN$` (Windows) directly, bypassing stdin entirely.

## Tool Namespace Collision Handling

When multiple upstream servers expose tools with the same name:
- Auto-namespace as `serverName__toolName` **only on collision**
- Single-server tools keep bare names (less LLM confusion)
- Configurable via `namespace: 'always' | 'on-collision'` (future)

## Policy Evaluation Priority

Tool-level policy > Server-level policy > Default (allow)

```typescript
// Server default
policy: 'approve-writes',

// Tool override (takes precedence)
tools: {
  drop_table: 'block',  // always blocked, regardless of server policy
}
```

## Write Detection

`approve-writes` and `read-only` detect writes by tool name prefix — not by argument inspection. Cannot parse SQL or file paths.

Write prefixes: `write`, `create`, `update`, `delete`, `remove`, `drop`, `insert`, `execute`, `exec`, `run`, `push`, `post`, `put`, `patch`, `set`, `send`, `deploy`, `destroy`, `reset`, `clear`, `purge`, `truncate`, `alter`.

Consequence: `execute_sql("SELECT …")` triggers approval under `approve-writes` because `execute` is a write prefix. This is intentional and correct.

## Config Loading

`cordon.config.ts` is loaded at runtime via `jiti` — no separate compile step. Users write TypeScript, Cordon runs it directly.

## Package Dependency Order

```
cordon-sdk (no deps)
  ↓
@cordon/core (depends on cordon-sdk + @modelcontextprotocol/sdk)
  ↓
cordon-cli (depends on @cordon/core + cordon-sdk)
```

Turborepo enforces this build order automatically.
