# Cordon

Security gateway for AI agents. Sits between the LLM client (Claude Desktop, Cursor) and MCP servers, enforcing policies, logging every tool call, and requiring human approval for dangerous operations.

## Project Layout

```
packages/
  sdk/    @getcordon/policy          — defineConfig() helper + all TypeScript types (no runtime deps)
  core/   @getcordon/core     — proxy engine: gateway, policy, approvals, audit, upstream manager
  cli/    @getcordon/cli          — CLI commands: `cordon start`, `cordon init`

examples/
  security-showcase/          — interactive demo + block-test.ts integration tests (5/5 passing)
```

Planning docs live in the parent directory (`../cordon-deux/`) alongside the code.


## Commands

```bash
npm install          # install all workspace deps
npm run build        # build all packages via turbo (respects dependency order: sdk → core → cli)
npm run dev          # watch mode for all packages
npm test             # run unit tests (vitest, 62 tests in @getcordon/core)
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
| `packages/core/src/approvals/slack.ts` | Slack approval channel — posts blocks to Slack, creates pending record on cordon-server, polls for response |
| `packages/core/src/approvals/manager.ts` | Wires terminal/slack channels based on config |
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
import { defineConfig } from '@getcordon/policy';

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

**Published versions (current as of 2026-05-02):**
- `@getcordon/policy@0.2.9` (sdk role; renamed from `cordon-sdk` on 2026-05-02)
- `@getcordon/core@0.3.2`
- `@getcordon/cli@0.2.1` (renamed from `cordon-cli` on 2026-05-02; bin name still `cordon`)

The unscoped names `cordon-sdk` and `cordon-cli` are deprecated on npm with migration pointers. They still resolve, but `npm install` warns users to switch.

To publish a new version (workspace dep order matters: sdk → core → cli):
```bash
npm login
cd packages/sdk  && npm version patch && npm run build && npm publish --access public --otp=XXXXXX
cd packages/core && npm version patch && npm run build && npm publish --access public --otp=XXXXXX
cd packages/cli  && npm version patch && npm run build && npm publish --access public --otp=XXXXXX
```

### npm content-policy pitfall — avoid SQL-injection literals in READMEs

npm's malware scanner returns 403 Forbidden ("forbidden by your security policy") on any package whose published content contains classic SQL-injection demo strings. Specifically, the literal `"SELECT 1; DROP TABLE x"` in the sdk README's SQL-aware-policies section was the trigger that blocked publishes for ~2 weeks (2026-04-19 → 2026-05-02). The block looked like a namespace/account dispute but was just a malware-scanner false positive on documentation content.

**Rule:** when documenting SQL detection or anti-injection features in any package README, describe the *shape* of the pattern rather than including the literal injection string. The scanner doesn't read prose — it pattern-matches across all included files (including README.md, which is always shipped in the npm tarball regardless of the `files` array in package.json).

If a future publish 403's with no obvious cause, run a stub-README publish to confirm; if that succeeds, bisect the README content. Likely culprits: any literal SQL injection demo, classic XSS payload (`<script>alert(1)</script>`), shell injection demos (`; rm -rf /`), or similar exploit pattern strings.

## Transport modes (both SHIPPED + published)

- **stdio** (default) — the Claude Desktop / Cursor spawning pattern. `StdioLifecycle`.
- **HTTP / Streamable HTTP** — SHIPPED and published in `@getcordon/core@0.5.0` (bundled into `dist/index.js`; the build inlines `src/transport/http.ts`, so there's no separate `dist/transport/` file — verify by grepping the bundle for `HTTPLifecycle` / "HTTP gateway listening", not by looking for a file). `createTransport()` in `src/transport/index.ts` selects `HTTPLifecycle` (`src/transport/http.ts`) when `config.gateway.transport === 'http'`; `gateway.ts` invokes it; CLI exposes `--port` (default 7777, path `/mcp`). Bearer-token auth (`Authorization: Bearer <authToken>`, constant-time compare), single-tenant. This is "Architecture A." **Do not re-open the "is HTTP wired?" question — it is, on `main` and on npm.**

## What's Not Built Yet (v1 deferred)

- **Multi-tenant** hosted HTTP gateway ("Architecture B" — per-tenant routing behind a hosted endpoint). The single-tenant HTTP above is done; only the multi-tenant hosted layer is deferred.
- OTLP audit output
- Dynamic policy reload (requires restart)
- Tool argument-level policies
- Rate limiting `onExceeded: 'queue'` mode (queue behavior currently acts as block)

## Hosted Backend (cordon-server)

Live at `https://app.getcordon.com` (hosted backend, deployed on Railway).

Dashboard: `https://app.getcordon.com/dashboard/` — GitHub OAuth login, users manage their own API keys.

To use hosted audit output:
```typescript
audit: {
  enabled: true,
  output: 'hosted',
  endpoint: 'https://app.getcordon.com',
  apiKey: 'crd_...',
}
```

To use Slack approvals (plug-and-play, server-driven since core@0.5.1 / cli@0.4.1):
```typescript
approvals: {
  channel: 'slack',
  // endpoint + apiKey auto-load from ~/.cordon/auth.json after `cordon login`.
  // No bot token / channel here — the workspace is connected once via
  // "Add to Slack" in the dashboard and cordon-server posts the card.
  timeoutMs: 60_000,
}
```

**Architecture (changed 2026-07-24 — do not revert to the old client-posts model):** the local proxy only *registers* a pending approval and polls; **cordon-server posts the Block Kit card** using the workspace's stored (AES-GCM encrypted) bot token. Workspaces connect via a **distributed Slack app** OAuth flow (`/slack/install` → `/slack/callback`, `slack_installs` table, migration 0008). `SlackApprovalChannel(endpoint, apiKey)` — the old `(botToken, channel, endpoint, apiKey)` signature and client-side `chat.postMessage` are gone. Backward-compat: if an old CLI sends `slackTs`, the server skips posting.

- Slack interactions hit `POST /webhooks/slack` — HMAC-verified against the single distributed-app `SLACK_SIGNING_SECRET`; the per-workspace bot token for `chat.update` is resolved by `team_id` from `slack_installs` (env `SLACK_BOT_TOKEN` is the legacy single-tenant fallback).
- Server env: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `TOKEN_ENC_KEY` (32-byte base64, encrypts stored bot tokens — never rotate it or stored installs become undecryptable).
- Self-host / single-tenant path (bring-your-own Slack app) documented in `docs/slack-approvals-setup.md`.

## Rate Limiting

`RateLimiter` class in `packages/core/src/rate-limiter.ts`. Sliding window (60s), three dimensions: global, per-server, per-tool. Blocked calls consume no slot. Wired into `Interceptor` — check runs before policy. Activated when `rateLimit` is present in config:

```typescript
rateLimit: {
  maxCallsPerMinute: 60,
  perServer: { database: 20 },
  perTool: { execute_sql: 10 },
  onExceeded: 'block', // 'queue' currently behaves same as 'block'
}
```

## Feature status

The shipped feature set (policy engine, call-graph rules, rate limiting, audit
logging + export, retention, terminal + Slack approvals, both transport modes)
is documented in the sections above. See `../cordon-deux/memory-bank/` for
roadmap and status.
