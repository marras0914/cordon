# Cordon

Security gateway for AI agents. Sits between the LLM client (Claude Desktop, Cursor) and MCP servers, enforcing policies, logging every tool call, and requiring human approval for dangerous operations.

## Project Layout

```
packages/
  sdk/    cordon-sdk       — defineConfig() helper + all TypeScript types (no runtime deps)
  core/   @getcordon/core     — proxy engine: gateway, policy, approvals, audit, upstream manager
  cli/    cordon-cli       — CLI commands: `cordon start`, `cordon init`

examples/
  security-showcase/       — interactive demo + block-test.ts integration tests (5/5 passing)
```

Planning docs live in the parent directory (`../cordon-deux/`) alongside the code.

## Commands

```bash
npm install          # install all workspace deps
npm run build        # build all packages via turbo (respects dependency order: sdk → core → cli)
npm run dev          # watch mode for all packages
```

Building a single package:
```bash
cd packages/core && npm run build
```

Running the integration test:
```bash
cd examples/security-showcase && npx tsx block-test.ts
```

Running the interactive demo:
```bash
cd examples/security-showcase && npm run demo
# When the approval prompt appears, type A to approve or D to deny
```

## Architecture

The proxy is an **aggregator**: one Cordon process presents a unified MCP server to Claude Desktop and internally manages N child MCP processes (one per configured server).

```
Claude Desktop ──stdio──▶ CordonGateway ──stdio──▶ [MCP server A]
                                         ──stdio──▶ [MCP server B]
```

**Critical**: `process.stdin` and `process.stdout` are owned by the MCP transport. All logging and approval UI must write to `process.stderr`. The terminal approval channel reads from `/dev/tty` (Unix) or `\\.\CONIN$` (Windows) directly — NOT from stdin.

## Key Files

| File | What it does |
|------|-------------|
| `packages/core/src/gateway.ts` | Entry point — wires everything together, registers MCP handlers |
| `packages/core/src/proxy/interceptor.ts` | Hot path — every tools/call flows through here |
| `packages/core/src/proxy/upstream-manager.ts` | Manages child MCP processes, tool registry, namespace collisions |
| `packages/core/src/policies/engine.ts` | Evaluates allow/block/approve/read-only/approve-writes/log-only |
| `packages/core/src/approvals/terminal.ts` | TTY-safe approval prompt |
| `packages/core/src/audit/logger.ts` | Structured JSON audit log to stderr or file |
| `packages/cli/src/commands/init.ts` | Reads claude_desktop_config.json, generates cordon.config.ts, patches Claude Desktop |
| `packages/cli/src/config-loader.ts` | Loads cordon.config.ts at runtime via jiti (no separate compile step) |
| `examples/security-showcase/dangerous-server.ts` | Mock MCP server used in demo |
| `examples/security-showcase/agent-sim.ts` | Interactive demo — simulates agent making tool calls |
| `examples/security-showcase/block-test.ts` | Non-interactive integration test |

## Policy Actions

| Policy | Behavior |
|--------|----------|
| `allow` | Pass through |
| `block` | Reject with error |
| `approve` | Pause, require human [A]/[D] in terminal |
| `approve-writes` | Reads pass; writes (detected by tool name prefix) require approval |
| `read-only` | Block all write operations |
| `log-only` | Pass through but flag in audit log |

Write detection uses tool name prefixes: `write`, `create`, `update`, `delete`, `execute`, `drop`, `insert`, `run`, `push`, `deploy`, etc.

## Tool Namespace Collision Handling

When two upstream servers expose a tool with the same name, Cordon auto-namespaces: `serverName__toolName`. If only one server has a given name, it's exposed bare (no namespace). This minimises LLM confusion in the common case.

## Config

Users write `cordon.config.ts` in their project root:

```typescript
import { defineConfig } from 'cordon-sdk';

export default defineConfig({
  servers: [
    {
      name: 'database',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@my-org/db-mcp'],
      policy: 'approve-writes',
      tools: {
        drop_table: { action: 'block', reason: 'Use a migration script instead' },
      },
    },
  ],
  audit: { enabled: true, output: 'stdout' },
  approvals: { channel: 'terminal', timeoutMs: 60_000 },
});
```

## SDK Version Notes

Using `@modelcontextprotocol/sdk` v1.11.x (stable). The v2 alpha splits into `@modelcontextprotocol/server` and `@modelcontextprotocol/client` — do not upgrade until v2 is stable.

`client.callTool()` returns a union type (includes a `CompatibilityCallToolResult` variant with `toolResult` instead of `content`). We use `Awaited<ReturnType<Client['callTool']>>` as the type alias (`ToolCallResponse`) rather than the named `CallToolResult` to avoid type narrowing issues.

`transport.stderr` is null before `client.connect()` is called. Pipe it after connect, not before.

## Publishing

npm username: `marras0914`
GitHub repo: `github.com/marras0914/cordon`

Package status:
- `cordon-sdk` — published at 0.1.0 (placeholder), bumped to 0.1.1 locally, needs `npm login` + publish
- `cordon-cli` — not yet published, name is available
- `@getcordon/core` — not yet published, name is available (needs `@cordon` npm org or rename to `cordon-core`)

To publish after `npm login`:
```bash
cd packages/sdk  && npm run build && npm publish --access public
cd packages/core && npm run build && npm publish --access public
cd packages/cli  && npm run build && npm publish --access public
```

## What's Not Built Yet (v1 deferred)

- HTTP/SSE transport (stdio only for now)
- Slack/webhook approval channels
- Web dashboard
- Rate limiting engine
- OTLP audit output
- Dynamic policy reload (requires restart)
- Tool argument-level policies

## Month 2 Targets (next big milestone)

- Hosted receiver for Slack/mobile approvals
- Web UI — audit log history viewer
- User auth (GitHub OAuth)
- Read-only mode toggle in dashboard
