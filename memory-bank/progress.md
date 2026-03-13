# Progress

## What's Built and Working

### cordon-sdk
- [x] `defineConfig()` helper — type-safe config authoring
- [x] All TypeScript types: `CordonConfig`, `ServerConfig`, `PolicyAction`, `ToolPolicy`, `ApprovalConfig`, `AuditConfig`, `RateLimitConfig`
- [x] Published on npm (0.1.0 placeholder, 0.1.1 ready)

### @cordon/core
- [x] `CordonGateway` — wires everything, registers MCP handlers
- [x] `UpstreamManager` — spawns child MCP processes, manages tool registry, handles namespace collisions
- [x] `Interceptor` — hot path, all tool calls flow through here
- [x] `PolicyEngine` — evaluates allow/block/approve/approve-writes/read-only/log-only
- [x] `ApprovalManager` — pluggable approval channels
- [x] `TerminalApprovalChannel` — TTY-safe prompt (stderr output, /dev/tty input)
- [x] `AuditLogger` — structured JSON to stderr and/or file

### cordon-cli
- [x] `cordon start` — loads config, starts gateway
- [x] `cordon init` — reads Claude Desktop config, generates cordon.config.ts, patches config
- [x] `loadConfig()` — jiti-based TypeScript config loader

### examples/security-showcase
- [x] `dangerous-server.ts` — mock MCP server with dangerous tools
- [x] `cordon.config.ts` — demo policy config (approve-writes + explicit blocks)
- [x] `agent-sim.ts` — interactive demo script
- [x] `block-test.ts` — non-interactive integration test (5/5 passing)

### Repo
- [x] README.md (accurate)
- [x] LICENSE (MIT)
- [x] CLAUDE.md (project context for Claude Code)
- [x] memory-bank/ (this directory)
- [x] Git initialized, 4 commits on main

## What's Not Built Yet

### Deferred to v2
- [ ] Slack approval channel
- [ ] Webhook approval channel
- [ ] Web dashboard (audit log history viewer)
- [ ] GitHub OAuth
- [ ] OpenTelemetry audit output
- [ ] Webhook audit output
- [ ] Rate limiting engine
- [ ] Audit log export (CSV/JSON)
- [ ] Team accounts / centralized governance
- [ ] HTTP/SSE transport (stdio only today)
- [ ] Dynamic policy reload without restart
- [ ] Tool argument-level policies (policy based on args, not just tool name)

## Known Limitations

- `execute_sql` with SELECT queries triggers `approve-writes` approval — write detection is by tool name prefix, not argument parsing. This is by design.
- Windows TTY approval uses `\\.\CONIN$` — may need testing on real Windows hardware.
- `cordon init` creates a backup of the original Claude Desktop config before patching.
