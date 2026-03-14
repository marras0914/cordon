# Progress

## What's Built and Working

### cordon-sdk
- [x] `defineConfig()` helper — type-safe config authoring
- [x] All TypeScript types: `CordonConfig`, `ServerConfig`, `PolicyAction`, `ToolPolicy`, `ApprovalConfig`, `AuditConfig`, `RateLimitConfig`
- [x] Published on npm: `cordon-sdk@0.1.1`

### @getcordon/core
- [x] `CordonGateway` — wires everything, registers MCP handlers
- [x] `UpstreamManager` — spawns child MCP processes, manages tool registry, handles namespace collisions
- [x] `Interceptor` — hot path, all tool calls flow through here
- [x] `PolicyEngine` — evaluates allow/block/approve/approve-writes/read-only/log-only
- [x] `ApprovalManager` — pluggable approval channels
- [x] `TerminalApprovalChannel` — TTY-safe prompt, singleton readline (Windows CONIN$ fix)
- [x] `AuditLogger` — structured JSON to stderr and/or file (with error handler)
- [x] Unit tests: 36 passing (PolicyEngine, AuditLogger, Interceptor)
- [x] Published on npm: `@getcordon/core@0.1.1`

### cordon-cli
- [x] `cordon start` — loads config, starts gateway
- [x] `cordon init` — reads Claude Desktop config, generates cordon.config.ts, patches config
- [x] `loadConfig()` — jiti-based TypeScript config loader
- [x] Published on npm: `cordon-cli@0.1.2`

### examples/security-showcase
- [x] `dangerous-server.ts` — mock MCP server with dangerous tools
- [x] `cordon.config.ts` — demo policy config (approve-writes + explicit blocks)
- [x] `agent-sim.ts` — interactive demo script (approved counter fixed)
- [x] `block-test.ts` — non-interactive integration test (5/5 passing)

### Repo
- [x] README.md (accurate, demo video embedded)
- [x] LICENSE (MIT)
- [x] CLAUDE.md (up to date)
- [x] memory-bank/ (this directory)
- [x] GitHub: `github.com/marras0914/cordon` — main is current build, v0.1-hono archived
- [x] GitHub release v0.2.0 with demo video

## What's In Progress

### Month 2 — Hosted Receiver (starting now)
- [ ] `POST /events` HTTP endpoint — accepts AuditEntry JSON, auth via API key
- [ ] Storage layer (DB per user)
- [ ] CLI: `audit.output: 'hosted'` + `audit.endpoint` config options
- [ ] Web dashboard — audit log history viewer
- [ ] GitHub OAuth
- [ ] Slack approval channel (depends on hosted receiver)

## What's Deferred to Later

- [ ] OpenTelemetry audit output
- [ ] Webhook audit output
- [ ] Rate limiting engine (type exists, not implemented)
- [ ] Audit log export (CSV/JSON)
- [ ] Team accounts / centralized governance
- [ ] HTTP/SSE transport (stdio only today)
- [ ] Dynamic policy reload without restart
- [ ] Tool argument-level policies (policy based on args, not just tool name)

## Known Limitations

- `execute_sql` with SELECT queries triggers `approve-writes` approval — write detection is by tool name prefix, not argument parsing. This is by design.
- `cordon init` creates a backup of the original Claude Desktop config before patching.
- Rate limiting config type exists but engine is not implemented — do not advertise.
