# Progress

## What's Built and Working

### cordon-sdk
- [x] `defineConfig()` helper — type-safe config authoring
- [x] All TypeScript types: `CordonConfig`, `ServerConfig`, `PolicyAction`, `ToolPolicy`, `ApprovalConfig`, `AuditConfig`, `RateLimitConfig`
- [x] Published on npm: `cordon-sdk@0.1.1`

### @getcordon/core
- [x] `CordonGateway` — wires everything, registers MCP handlers
- [x] `UpstreamManager` — spawns child MCP processes, manages tool registry, handles namespace collisions, removes stale tools on disconnect, pipes upstream stderr
- [x] `Interceptor` — hot path, all tool calls flow through here
- [x] `PolicyEngine` — evaluates allow/block/approve/approve-writes/read-only/log-only (fail-secure default)
- [x] `ApprovalManager` — pluggable approval channels
- [x] `TerminalApprovalChannel` — TTY-safe prompt, singleton readline (Windows CONIN$ fix)
- [x] `AuditLogger` — structured JSON to stderr, file, or hosted receiver (with error handler + retry on failure)
- [x] `HostedAuditOutput` — batches events, POSTs to cordon-server, retries on failure
- [x] Unit tests: 36 passing (PolicyEngine, AuditLogger, Interceptor)
- [x] Published on npm: `@getcordon/core@0.1.1`

### cordon-cli
- [x] `cordon start` — loads config, starts gateway, exits code 1 on shutdown error
- [x] `cordon init` — reads Claude Desktop config, generates cordon.config.ts, patches config; clear messaging for all 3 cases (patched / not found / no servers)
- [x] `loadConfig()` — jiti-based TypeScript config loader
- [x] Published on npm: `cordon-cli@0.1.2`

### examples/security-showcase
- [x] `dangerous-server.ts` — mock MCP server with dangerous tools
- [x] `cordon.config.ts` — demo policy config (approve-writes + explicit blocks)
- [x] `agent-sim.ts` — interactive demo script (approved counter fixed)
- [x] `block-test.ts` — non-interactive integration test (5/5 passing)

### cordon-server (separate repo: github.com/marras0914/cordon-server)
- [x] `POST /events` — ingest audit events, auth via X-Cordon-Key header
- [x] `GET /events` — retrieve recent events (paginated, max 500)
- [x] `POST /admin/keys` — create API key (returned once)
- [x] `GET /admin/keys` — list keys (no values returned)
- [x] `DELETE /admin/keys/:id` — revoke key
- [x] Postgres schema: `api_keys` + `events` tables, `isError` as boolean
- [x] All DB ops wrapped in try/catch, proper 500 responses
- [x] Admin protected by `X-Admin-Secret` env var, 100-char name limit

### Repo
- [x] README.md (accurate, demo video embedded)
- [x] LICENSE (MIT)
- [x] CLAUDE.md (up to date)
- [x] memory-bank/ (this directory)
- [x] GitHub: `github.com/marras0914/cordon` — main is current build, v0.1-hono archived
- [x] GitHub release v0.2.0 with demo video
- [x] Git author: arras.marco@gmail.com (history rewritten in both repos)

## What's In Progress

### Outreach
- [ ] HN Show HN — karma building on account `babas03`, retry when karma > 5
- [ ] Find 2-3 engineers using MCP in production for design partner conversations

### Month 2 — Next to Build
- [ ] Railway deployment (waiting until first user asks for it)
- [ ] DB migrations (`npm run db:generate && npm run db:migrate`)
- [ ] Web dashboard — audit log history viewer
- [ ] GitHub OAuth for user accounts
- [ ] Slack approval channel

## What's Deferred to Later

- [ ] OpenTelemetry audit output
- [ ] Webhook audit output
- [ ] Rate limiting engine (type exists, not implemented — do not advertise)
- [ ] Audit log export (CSV/JSON)
- [ ] Team accounts / centralized governance
- [ ] HTTP/SSE transport (stdio only today)
- [ ] Dynamic policy reload without restart
- [ ] Tool argument-level policies (policy based on args, not just tool name)

## Known Limitations

- `execute_sql` with SELECT queries triggers `approve-writes` approval — write detection is by tool name prefix, not argument parsing. This is by design.
- `cordon init` creates a backup of the original Claude Desktop config before patching.
- Rate limiting config type exists but engine is not implemented — do not advertise.
- cordon-server not yet deployed — Railway setup deferred until first user.
