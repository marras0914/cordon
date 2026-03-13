# Security Showcase

Demonstrates Cordon intercepting an AI agent making dangerous tool calls against a production database.

## What this shows

A simulated agent works through 7 tool calls in escalating order of danger:

| Tool call | Expected outcome |
|-----------|-----------------|
| `read_data("customers")` | ✓ Passed through — clearly a read |
| `read_data("sessions")` | ✓ Passed through — clearly a read |
| `execute_sql("SELECT …")` | ⚠ Approval required — `execute_sql` is write-capable |
| `execute_sql("DELETE …")` | ⚠ Approval required — write operation |
| `write_file("/etc/…")` | ⚠ Approval required — write operation |
| `drop_table("users")` | ✗ Blocked — policy explicitly blocks this |
| `delete_file("/var/log/…")` | ✗ Blocked — policy explicitly blocks this |

The policy in `cordon.config.ts`:

```typescript
policy: 'approve-writes',   // reads pass, writes need human approval
tools: {
  drop_table:  { action: 'block' },  // never, regardless of approval
  delete_file: { action: 'block' },  // never, regardless of approval
}
```

## Run the interactive demo

```bash
cd examples/security-showcase
npm install
npm run demo
```

When the approval prompt appears, type `A` to approve or `D` to deny.

```
⚠  APPROVAL REQUIRED
  Server : demo-db
  Tool   : execute_sql
  Args   : { "query": "DELETE FROM sessions WHERE expires_at < NOW()" }

  [A]pprove  [D]eny
  >
```

## Run the automated block test

Verifies all policy decisions without interactive input:

```bash
npx tsx block-test.ts
```

Expected output:
```
✓ read_data      (should allow)
✓ execute_sql    (should allow)
✓ write_file     (should allow)
✓ drop_table     (should block)
✓ delete_file    (should block)

All tests passed.
```

## Why `execute_sql("SELECT …")` triggers approval

Cordon's write-detection works on **tool names**, not argument contents. It can't parse SQL — that would require understanding the schema of every upstream tool.

Since `execute_sql` starts with `execute` (a write-indicating prefix), Cordon treats it as write-capable regardless of the actual query. If you want SELECT queries to pass through, add a per-tool override:

```typescript
tools: {
  execute_sql: 'allow',          // trust all SQL (risky)
  // or use a separate read-only query tool in your MCP server
}
```

## Files

| File | Purpose |
|------|---------|
| `dangerous-server.ts` | Mock MCP server exposing dangerous tools |
| `cordon.config.ts` | Cordon policy config for this demo |
| `agent-sim.ts` | Interactive demo — simulates an agent, shows approval prompts |
| `block-test.ts` | Non-interactive test — verifies block/allow decisions |
