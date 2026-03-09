# Cordon – Project Instructions

## What This Is
Cordon is a Policy-as-Code MCP Security Gateway. It sits as a reverse proxy between AI agents and MCP tool servers, enforcing ALLOW / BLOCK / REQUIRE_APPROVAL policies with a full audit trail, HITL approval queue, PII redaction, rate limiting, webhook alerting, and a Python SDK.

**GitHub:** https://github.com/marras0914/cordon

## Phase Status
- Phase 1: Open-source MVP ✅ — proxy, policy engine, Docker
- Phase 2: SaaS ✅ — audit log, dashboard, HITL approvals, dashboard auth, tests
- Phase 3: Enterprise ✅ — OPA, PII redaction, SSO/OIDC, Postgres, NERC CIP export, Helm chart
- Phase 4: Distribution ✅ — rate limiting, alerting, SDK, README/docs, CI/CD, PyPI, GHCR, ArtifactHub

## Repo Layout
```
cordon/
  build_cordon.py               # Packager — zips cordon_gateway/ for distribution
  CLAUDE.md                     # This file
  .gitignore
  .github/
    workflows/
      ci.yml                    # Tests on every push/PR (Python 3.11+3.12, Helm lint)
      release.yml               # On git tag: Docker→GHCR, SDK→PyPI, Helm→Pages, GitHub Release
  cordon_gateway/               # The deployable project
    main.py                     # FastAPI gateway — SSE proxy, interceptor, rate limit, alerting
    dashboard.py                # Dashboard at /dashboard — audit log, approvals, policy editor, export
    db.py                       # SQLite/Postgres audit log and approval queue
    auth.py                     # OIDC/PKCE + session signing (itsdangerous)
    pii.py                      # PII redaction (EMAIL, SSN, PHONE, CREDIT_CARD, IPV4)
    ratelimit.py                # Per-client sliding window rate limiter
    alerting.py                 # Webhook alerting (Slack/Teams compatible)
    cordon_sdk.py               # Gateway copy of the SDK (for local use / tests)
    policy.yaml                 # YAML policy rules (hot-reloaded)
    policy.rego                 # OPA Rego policy (used by OPA sidecar)
    Dockerfile
    docker-compose.yml          # Dev: gateway + OPA + mock server
    docker-compose.prod.yml     # Prod: gateway + OPA + Postgres
    .env.example                # Environment variable template
    Makefile                    # make dev / prod / test / build / push / helm-*
    requirements.txt
    README.md
    ARCHITECTURE.md
    docs/
      policy.md                 # YAML + OPA policy guide
      sdk.md                    # SDK usage reference
      helm.md                   # Helm deployment guide
      compliance.md             # NERC CIP export guide
    helm/cordon/                # Helm chart — gateway + OPA sidecar, secrets, PVC, ingress
    sdk_package/                # PyPI-publishable cordon-sdk package
      pyproject.toml
      src/cordon_sdk/
        __init__.py
        client.py
    tests/                      # 143 tests across 9 files
```

## Key Conventions
- **Language:** Python 3.11+
- **Framework:** FastAPI
- **DB:** SQLite (default, stdlib `sqlite3`) or Postgres (`DATABASE_URL` env var); no ORM
- **Policy:** YAML hot-reloaded every request; OPA evaluated first when `CORDON_OPA_URL` is set
- **Dashboard:** Server-rendered HTML via f-string templates — no JS framework, no build step
- **Transport:** MCP over SSE — `GET /sse` (stream) and `POST /messages` (JSON-RPC)
- **Image registry:** `ghcr.io/marras0914/cordon-gateway`

## JSON-RPC Error Codes
- `-32001` — BLOCK (policy violation or human rejection)
- `-32002` — REQUIRE_APPROVAL (queued, retry with `X-Cordon-Approval-Id` header)
- `-32003` — Backend unreachable
- `-32005` — Rate limit exceeded

## Key Environment Variables
| Variable | Default | Notes |
|---|---|---|
| `REAL_MCP_SERVER` | `http://localhost:8001` | Upstream MCP server |
| `CORDON_OPA_URL` | _(empty)_ | Enables OPA policy engine |
| `CORDON_REDACT_PII` | `true` | PII scrubbing before DB writes |
| `CORDON_RATE_LIMIT` | `60` | Calls/window per IP; 0=disabled |
| `CORDON_RATE_WINDOW` | `60` | Window size in seconds |
| `CORDON_WEBHOOK_URL` | _(empty)_ | Slack/Teams alert webhook |
| `CORDON_DASHBOARD_KEY` | _(empty)_ | Shared key auth; unset=open |
| `CORDON_SESSION_SECRET` | _(auto)_ | Session signing — set in prod |
| `DATABASE_URL` | _(empty)_ | Postgres; unset=SQLite |
| `CORDON_DB` | `cordon_audit.db` | SQLite file path |

## HITL Approval Flow
1. Agent calls tool → gets `-32002` with UUID `approval_id`
2. Operator approves/rejects at `/dashboard/approvals`
3. Agent retries with `X-Cordon-Approval-Id: {uuid}` → Cordon forwards or blocks

## Auth Priority
OIDC (all 3 vars set) → shared key (`CORDON_DASHBOARD_KEY`) → open (dev)

## URLs
- Gateway: `http://localhost:8000`
- Dashboard: `http://localhost:8000/dashboard/`
- Approvals: `http://localhost:8000/dashboard/approvals`
- Policy editor: `http://localhost:8000/dashboard/policy`
- Export: `http://localhost:8000/dashboard/export`

## Running Tests
```bash
cd cordon_gateway
python -m pytest tests/ -v
```
143 tests across: test_gateway, test_dashboard, test_opa, test_pii, test_auth, test_export, test_ratelimit, test_alerting, test_sdk

## Releasing
```bash
git tag v0.1.0
git push origin main --tags
# GitHub Actions handles: GHCR image, PyPI SDK, Helm chart, GitHub Release zip
```

## Encoding Note
Windows cp1252: any file writes must use `encoding="utf-8"`. Avoid emoji in print statements.
