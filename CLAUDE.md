# Cordon – Project Instructions

## What This Is
Cordon is a Policy-as-Code MCP Security Gateway. It sits as a reverse proxy between AI agents and MCP tool servers, enforcing ALLOW / BLOCK / REQUIRE_APPROVAL policies and maintaining a full audit trail.

**Roadmap (from gemini-convo.MD):**
- Phase 1: Open-source MVP ✅ (proxy + policy engine + Docker)
- Phase 2: Pro/Team SaaS — audit log dashboard ✅ (db.py + dashboard.py), next: real HITL approval flow
- Phase 3: Enterprise — SSO, PII redaction, OPA integration, on-prem packaging for energy utilities

## Repo Layout
```
cordon/
  build_cordon.py          # Builder script — regenerates cordon_gateway/ and zips it
  CLAUDE.md                # This file
  cordon_gateway/          # The actual deployable project
    main.py                # FastAPI gateway (SSE proxy + message interceptor + audit logging)
    dashboard.py           # Dashboard app mounted at /dashboard (audit log + policy editor)
    db.py                  # SQLite audit log (cordon_audit.db)
    policy.yaml            # Policy rules (ALLOW / BLOCK / REQUIRE_APPROVAL)
    Dockerfile
    docker-compose.yml
    requirements.txt
    README.md
    ARCHITECTURE.md
    gemini-convo.MD        # Original design conversation — source of truth for roadmap
```

## Key Conventions
- **Language:** Python 3.11+
- **Framework:** FastAPI
- **DB:** SQLite via stdlib `sqlite3` (no ORM, keep it simple)
- **Policy engine:** YAML-based (`policy.yaml`), hot-reloaded on every request
- **Dashboard:** Server-rendered HTML (no JS framework, no build step) — Jinja2-style f-string templates in `dashboard.py`
- **Transport:** MCP over SSE — two channels: `GET /sse` (stream) and `POST /messages` (JSON-RPC)
- **Deployment:** Docker Compose — gateway on port 8000, mock MCP server on 8001

## Encoding Note
`build_cordon.py` must use `encoding="utf-8"` when writing files — Windows cp1252 cannot encode emoji. Print statements in the builder should avoid emoji for the same reason.

## URLs
- Gateway: `http://localhost:8000`
- Dashboard: `http://localhost:8000/dashboard/`
- Policy editor: `http://localhost:8000/dashboard/policy`
- Mock MCP backend: `http://localhost:8001`

## Dependencies
```
fastapi==0.109.2
uvicorn==0.27.1
httpx==0.26.0
pyyaml==6.0.1
python-multipart==0.0.9   # required for dashboard form POSTs
```

## HITL Approval Flow
- Agent gets `-32002` with `approval_id` UUID in error message
- Operator approves/rejects at `/dashboard/approvals`
- Agent retries with `X-Cordon-Approval-Id: {uuid}` header → Cordon checks DB and forwards or blocks

## Dashboard Auth
- `CORDON_DASHBOARD_KEY` env var — if set, enables cookie-based login at `/dashboard/login`
- If unset, dashboard is open (dev mode)

## What's NOT Done Yet
- Tests
- Phase 3: SSO, PII redaction, OPA integration, on-prem packaging
