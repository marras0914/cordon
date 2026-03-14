# Cordon

Security gateway for AI agents. Sits between the LLM client (Claude Desktop, Cursor) and MCP servers, enforcing policies, logging every tool call, and requiring human approval for dangerous operations.

## Project Layout

```
packages/
  sdk/    cordon-sdk          — defineConfig() helper + all TypeScript types (no runtime deps)
  core/   @getcordon/core     — proxy engine: gateway, policy, approvals, audit, upstream manager
  cli/    cordon-cli          — CLI commands: `cordon start`, `cordon init`

examples/
  security-showcase/          — interactive demo + block-test.ts integration tests (5/5 passing)
```

Planning docs live in the parent directory (`../cordon-deux/`) alongside the code.


## Commands

```bash
npm install          # install all workspace deps
npm run build        # build all packages via turbo (respects dependency order: sdk → core → cli)
npm run dev          # watch mode for all packages
npm test             # run unit tests (vitest, 36 tests in @getcordon/core)
```

Building a single package:
```bash
cd packages/core && npm run build
```

Running tests:
```bash
npm test                                                    # all unit tests via turbo
cd examples/security-showcase && npx tsx block-test.ts     # integration test (5/5)
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

**Windows TTY**: `\\.\CONIN$` must be opened ONCE per process as a singleton readline interface. Re-opening it for each approval request causes subsequent reads to get immediate EOF. The shared readline in `terminal.ts` queues resolvers via `lineResolvers[]`.

**Upstream disconnect handling**: `transport.onclose` in `UpstreamManager.connectServer()` removes the disconnected server from `this.clients` and purges its tools from `this.registry`. This prevents the LLM from being offered tools from a dead server. Also pipes upstream stderr so server logs are visible.

## Key Files

| File | What it does |
|------|-------------|
| `packages/core/src/gateway.ts` | Entry point — wires everything together, registers MCP handlers |
| `packages/core/src/proxy/interceptor.ts` | Hot path — every tools/call flows through here |
| `packages/core/src/proxy/upstream-manager.ts` | Manages child MCP processes, tool registry, namespace collisions, stale tool cleanup on disconnect |
| `packages/core/src/policies/engine.ts` | Evaluates allow/block/approve/read-only/approve-writes/log-only |
| `packages/core/src/approvals/terminal.ts` | TTY-safe approval prompt (singleton readline) |
| `packages/core/src/audit/logger.ts` | Structured JSON audit log to stderr or file |
| `packages/core/src/__tests__/` | Unit tests: policy-engine, audit-logger, interceptor (36 tests) |
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

Write detection uses tool name prefixes with `_` or `-` separator: `write_*`, `create_*`, `delete_*`, `execute_*`, `drop_*`, etc. Bare exact matches also count (tool named exactly `write`). Tools like `writer_notes` are NOT matched (no separator after prefix).

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
npm org: `getcordon` (org name `cordon` was taken)

**Published versions:**
- `cordon-sdk@0.1.1` ✓
- `@getcordon/core@0.1.1` ✓
- `cordon-cli@0.1.2` ✓

To publish a new version:
```bash
npm login
cd packages/sdk  && npm version patch && npm run build && npm publish --access public --otp=XXXXXX
cd packages/core && npm version patch && npm run build && npm publish --access public --otp=XXXXXX
cd packages/cli  && npm version patch && npm run build && npm publish --access public --otp=XXXXXX
```

## What's Not Built Yet (v1 deferred)

- HTTP/SSE transport (stdio only for now)
- Slack/webhook approval channels
- Web dashboard
- Rate limiting engine (config type exists but is ignored — do not advertise)
- OTLP audit output
- Dynamic policy reload (requires restart)
- Tool argument-level policies

## Month 2 Targets (next big milestone)

- Hosted receiver for Slack/mobile approvals
- Web UI — audit log history viewer
- User auth (GitHub OAuth)
- Read-only mode toggle in dashboard
