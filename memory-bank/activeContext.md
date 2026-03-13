# Active Context

## Current State (2026-03-13)

Month 1 of the roadmap is essentially complete on the code side. The repo is ready to go public.

### What Was Just Built (this session)

- Full monorepo from scratch: `cordon-sdk`, `@cordon/core`, `cordon-cli`
- All packages build clean via Turborepo + tsup
- End-to-end integration test passing (5/5): allow, block, and approve-writes all verified
- `examples/security-showcase/` — interactive agent-sim demo + non-interactive block-test
- `README.md` — accurate, matches real API, real GitHub handle, no aspirational checkmarks
- `LICENSE` (MIT)
- Git initialized, 4 commits on `main`

### Pending (needs manual action)

**Push to GitHub:**
```bash
cd cordon
git remote add origin https://github.com/marras0914/cordon.git
git push -u origin main
```

**Publish to npm:**
```bash
npm login   # current token is expired/restricted
# Decision needed: @cordon/core scope requires npm org "cordon" at npmjs.com/org/create
# OR rename package to cordon-core (simpler)

cd packages/sdk  && npm run build && npm publish --access public   # v0.1.1
cd packages/core && npm run build && npm publish --access public   # v0.1.0
cd packages/cli  && npm run build && npm publish --access public   # v0.1.0
```

**Record demo video:**
- Script: `cd examples/security-showcase && npm run demo`
- Show the approval prompt appearing, type A for the write, show the block for `drop_table`
- This is the content that drives GitHub stars

## Open Decisions

1. **`@cordon/core` vs `cordon-core`** — scoped name is cleaner but requires creating a npm org. Unscoped is faster to ship.

2. **Demo video format** — terminal recording (asciinema/vhs) or screen capture? Needs to show the approval prompt clearly.

## Next Up After Launch

Month 2 — the SaaS layer:
- Hosted endpoint that receives audit log events
- Web dashboard (audit log history, approval decisions)
- GitHub OAuth for user accounts
- Slack approval channel

This is where the business model kicks in. The CLI is the funnel.
