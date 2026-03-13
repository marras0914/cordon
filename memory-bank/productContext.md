# Product Context

## Why This Exists

MCP adoption is accelerating but security tooling is essentially nonexistent. The closest competitor (mcp-guardian) validated the market then stalled — dormant since August 2025, stdio-only, no hosted layer, rough install experience.

Cordon's position: same core idea, dramatically better DX, and a clear path to a SaaS product.

## Competitive Landscape

**mcp-guardian (eqtylab)**
- Most direct competitor. Rust + TypeScript, v0.6.0, ~7 months stale.
- Does: stdio interception, manual approvals, audit logging, tool fingerprinting.
- Doesn't: HTTP transport, hosted layer, polished install, schema-validated config.
- Install: manual .dmg download with broken code signing on macOS.
- 193 stars. One active maintainer. Appears abandoned.

**mcp-scan (Invariant Labs)**
- Security scanner, not a governance layer. Different use case.

**General-purpose proxies (tbxark/mcp-proxy, etc.)**
- Aggregation only, no security features.

## Differentiation

1. **DX** — `npx cordon-cli start` vs. manual binary download
2. **Config** — `defineConfig()` TypeScript with types vs. raw JSON editing
3. **SaaS layer** — cloud dashboard, team accounts, compliance exports (nobody else has this)
4. **Active maintenance** — responsiveness itself becomes a moat when competitors are dormant

## The Open Source CLI Is Distribution, Not the Product

The CLI gets developers in the door. The hosted dashboard is what generates revenue. Every decision should ask: "does this get us closer to a paying design partner?"

## Roadmap

**Month 1 — Wedge (OSS Alpha)**
- [x] Working proxy with policy engine
- [x] Terminal approvals
- [x] Audit logging
- [x] Security showcase demo
- [x] README and npm packages
- [ ] Demo video
- [ ] GitHub stars

**Month 2 — Control Plane (Private Beta)**
- Hosted receiver for Slack/mobile approvals
- Web UI — audit log history viewer
- User auth (GitHub OAuth)
- Read-only mode toggle in dashboard

**Month 3 — Monetization**
- Audit export (CSV/JSON) for compliance teams
- Rate limiting engine
- 30-day log retention on Pro tier
- First paying design partner at $49/mo
