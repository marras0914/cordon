# cordon-sdk

TypeScript SDK for configuring [Cordon](https://github.com/marras0914/cordon), the security gateway for MCP tool calls.

This package exports `defineConfig` and the config type surface. You only need it if you're writing a `cordon.config.ts` file.

## Install

```bash
npm install cordon-sdk
```

`cordon init` (from the `cordon-cli` package) installs this automatically into your project.

## Usage

```typescript
import { defineConfig } from 'cordon-sdk';

export default defineConfig({
  servers: [
    {
      name: 'database',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', process.env.POSTGRES_URL!],
      policy: 'read-only',
    },
    {
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      policy: 'approve-writes',
      tools: {
        delete_repository: 'block',
        create_pull_request: 'approve',
      },
    },
  ],

  audit: {
    enabled: true,
    output: 'file',       // 'stdout' | 'file' | 'hosted'
  },

  approvals: {
    channel: 'terminal',  // 'terminal' | 'slack'
    timeoutMs: 60_000,
  },

  rateLimit: {
    perServerPerMinute: 60,
  },
});
```

## Policy actions

| Policy | Behavior |
|---|---|
| `allow` | Pass through immediately |
| `block` | Reject with an error |
| `approve` | Pause the agent, prompt for human approval |
| `approve-writes` | Reads pass through, writes require approval |
| `read-only` | Writes are blocked, reads pass through |
| `log-only` | Pass through, flagged in audit log |
| `hidden` | Filtered from tools/list — the model never sees it |
| `sql-read-only` | Parse the SQL arg; allow SELECT, block everything else (fail-closed on unparseable) |
| `sql-approve-writes` | Parse the SQL arg; allow reads, pause writes for approval, block unparseable |

Policies can be set at the server level or per-tool. Per-tool overrides the server default.

## SQL-aware policies

For database MCP servers where a single tool takes arbitrary SQL, Cordon can parse the statement and decide based on type rather than tool name:

```typescript
tools: {
  query: 'sql-read-only',            // default: inspects arg named 'sql'
  execute: 'sql-approve-writes',
  run: { action: 'sql-read-only', sqlArg: 'statement' },  // custom arg name
}
```

- Uses PostgreSQL dialect. Other dialects: future release.
- Fail-closed: unparseable SQL (malformed, non-string, missing arg) is blocked rather than allowed.
- Classified as reads: `SELECT`, `WITH ... SELECT` CTEs, `SHOW`, bare `EXPLAIN SELECT/...` (the leading EXPLAIN is stripped before classifying the inner statement).
- Classified as writes: everything else — INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CREATE/SET/BEGIN/COMMIT/ROLLBACK etc. `EXPLAIN ANALYZE` is deliberately NOT stripped (ANALYZE actually executes the query) and falls through to unknown.
- Multi-statement input like `"SELECT 1; DROP TABLE x"` classifies as write if any statement is non-read.

### Known parser limitations (PostgreSQL dialect)

The underlying `node-sql-parser` doesn't parse these in PG mode, so they fall through to `'unknown'` and get blocked under `sql-read-only` (you'd need to switch to `sql-approve-writes`, add a tool-level override, or wrap the intent in a supported form):

- `DESCRIBE users` / `DESC users` (MySQL-style; use `SELECT * FROM information_schema.columns WHERE table_name = 'users'` instead)
- Standalone `VALUES (1, 2), (3, 4)` (wrap in `SELECT * FROM (VALUES ...) AS t(a,b)`)
- `PRAGMA foreign_keys = ON` (SQLite-specific)
- `EXPLAIN ANALYZE ...` (deliberately not supported — ANALYZE runs the query)

## Closed-world tool catalogs

Opt into a strict list of tools your upstream server is allowed to advertise. New tools added in future upstream releases are blocked until you approve them explicitly:

```typescript
{
  name: 'postgres',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-postgres', process.env.POSTGRES_URL!],
  policy: 'read-only',
  knownTools: ['query', 'list_tables', 'describe_table'],
  onUnknownTool: 'block',  // default when knownTools is set
}
```

- `knownTools: string[]` — tools you've vouched for. Tools keyed in `tools` (with explicit policy overrides) are also treated as known.
- `onUnknownTool: 'block' | 'allow'` — default `'block'`. With `'allow'`, unknown tools still pass through but emit a stderr warning.
- Leave `knownTools` undefined to disable the check (backwards compatible).

## Full documentation

Complete reference including all config fields, approval channels, and audit outputs:
**https://github.com/marras0914/cordon**

## License

MIT
