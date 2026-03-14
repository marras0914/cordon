# Active Context

## Current State (2026-03-14)

Month 1 is complete and shipped. Now in Month 2 — building the SaaS layer.

### Month 1 — Completed

- Full monorepo: `cordon-sdk`, `@getcordon/core`, `cordon-cli`
- All packages published on npm (`cordon-sdk@0.1.1`, `@getcordon/core@0.1.1`, `cordon-cli@0.1.2`)
- GitHub repo live: `github.com/marras0914/cordon` (old Hono arch archived on `v0.1-hono`)
- GitHub release v0.2.0 with demo video embedded in README
- 36 unit tests passing (PolicyEngine, AuditLogger, Interceptor)
- Integration test 5/5 passing
- Windows TTY approval bug fixed (singleton readline for `\\.\CONIN$`)
- Code review completed, real bugs fixed

### Outreach Status

- HN Show HN blocked (karma too low — `babas03` account, karma=1)
- Commenting on HN threads to build karma — retry Show HN in 1-2 days
- LinkedIn not posted yet (user prefers not to)
- Show HN draft ready to go (see productContext.md)

## Month 2 — Active Plan

**Goal:** Build the hosted receiver first. Everything else (dashboard, Slack, OAuth) depends on it.

### Phase 1: Hosted Audit Receiver (building now)
A simple HTTP service that accepts the structured JSON audit events Cordon already emits. This is the foundation.

- HTTP endpoint: `POST /events` — accepts `AuditEntry` JSON
- Auth: API key per user (header: `X-Cordon-Key`)
- Storage: append to DB per user
- CLI side: new `audit.output: 'hosted'` + `audit.endpoint` config options

### Phase 2: Web Dashboard
- Audit log history viewer (read from DB)
- GitHub OAuth for user accounts
- Per-tool approval decision history

### Phase 3: Slack Approval Channel
- Webhook-based approval: Cordon sends Slack message, waits for button click
- Requires hosted receiver to be running (handles the callback)

### Phase 4: Monetization
- 30-day log retention on Pro tier ($49/mo)
- Audit export (CSV/JSON) for compliance
- Team accounts

## Open Questions for Month 2

1. **Stack for hosted receiver** — what does the user want to build with? (Node/Hono, Python/FastAPI, etc.)
2. **Database** — Postgres (Supabase/Neon) or SQLite to start?
3. **Hosting** — Railway, Fly.io, Vercel?

## Known Limitations (carry-forward)

- `execute_sql` with SELECT queries triggers `approve-writes` approval — write detection is by tool name prefix, not argument parsing. This is by design.
- Windows TTY approval uses singleton readline on `\\.\CONIN$` — tested and working.
- `cordon init` creates a backup of the original Claude Desktop config before patching.
- Rate limiting config type exists but is not implemented — do not advertise.
