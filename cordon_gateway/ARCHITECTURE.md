# Cordon Architecture

## Overview

Cordon is a **reverse proxy** built on FastAPI that intercepts MCP (Model Context Protocol) traffic. It implements the interceptor pattern: the AI agent sees Cordon as its MCP server, and Cordon forwards traffic to the real server after policy evaluation.

---

## Component Map

```
 ┌─────────────────────────────────────────────────────────────────────┐
 │  AI Agent Process (Claude, Cursor, custom agent)                    │
 └────────────────────┬────────────────────────────────────────────────┘
                      │  HTTP (SSE + JSON-RPC)
                      ▼
 ┌─────────────────────────────────────────────────────────────────────┐
 │  Cordon Gateway  :8000                                              │
 │                                                                     │
 │  ┌─────────────┐   ┌──────────────┐   ┌───────────────────────┐   │
 │  │  main.py    │   │  policy      │   │  db.py                │   │
 │  │             │──▶│  evaluation  │   │  SQLite / Postgres     │   │
 │  │  /sse       │   │  (OPA first, │   │  audit_log            │   │
 │  │  /messages  │   │  YAML fallb.)│   │  approval_queue       │   │
 │  └──────┬──────┘   └──────────────┘   └───────────────────────┘   │
 │         │                                                           │
 │  ┌──────▼──────┐   ┌──────────────┐   ┌───────────────────────┐   │
 │  │  pii.py     │   │  ratelimit   │   │  alerting.py          │   │
 │  │  redact PII │   │  sliding win.│   │  webhook (Slack/Teams)│   │
 │  └─────────────┘   └──────────────┘   └───────────────────────┘   │
 │                                                                     │
 │  ┌────────────────────────────────────────────────────────────┐    │
 │  │  /dashboard  (mounted FastAPI sub-app)                     │    │
 │  │  audit log · approval queue · policy editor · export       │    │
 │  └────────────────────────────────────────────────────────────┘    │
 └─────────────────────┬───────────────────────────────────────────────┘
                       │
         ┌─────────────┴──────────────┐
         │                            │
         ▼                            ▼
 ┌───────────────┐           ┌────────────────┐
 │  OPA Server   │           │  Real MCP      │
 │  :8181        │           │  Server :8001  │
 │  policy.rego  │           │  (forwarded    │
 │  (optional)   │           │   ALLOW calls) │
 └───────────────┘           └────────────────┘
```

---

## Request Lifecycle (`tools/call`)

```
POST /messages
      │
      ▼
1. Rate limit check  ──EXCEEDED──▶  -32005 error + BLOCK log + webhook
      │ OK
      ▼
2. PII redaction of arguments (safe copy for storage)
      │
      ▼
3. Policy evaluation
      │  ┌─ OPA available? ──YES──▶  POST /v1/data/cordon/decision
      │  │                                    │ timeout/error
      │  │                                    ▼
      │  └─ fallback ◀─────────────── policy.yaml lookup
      │
      ├── BLOCK ──────────────▶  -32001 error + audit log + webhook
      │
      ├── REQUIRE_APPROVAL ──▶  Queue entry created (UUID)
      │        │                audit log + queue alert
      │        │
      │        │  Agent retries with X-Cordon-Approval-Id header
      │        ▼
      │   Check approval status
      │        ├── PENDING  ──▶  -32002 error (same UUID)
      │        ├── REJECTED ──▶  -32001 error + audit log
      │        └── APPROVED ──▶  forward (step 4)
      │
      └── ALLOW ─────────────▶  forward
                                     │
                               4. POST to REAL_MCP_SERVER
                                     │
                               5. Return response to agent
```

---

## Modules

| File | Responsibility |
|---|---|
| `main.py` | FastAPI app, SSE proxy, `tools/call` interception, request routing |
| `db.py` | Audit log + approval queue. SQLite (default) or Postgres (`DATABASE_URL`) |
| `dashboard.py` | Operator UI — audit log, approvals, policy editor, compliance export |
| `auth.py` | Session signing, OIDC/PKCE flow, JWT validation against JWKS |
| `pii.py` | Recursive PII redaction (EMAIL, SSN, PHONE, CREDIT_CARD, IPV4) |
| `ratelimit.py` | In-memory sliding window rate limiter, per client IP |
| `alerting.py` | Fire-and-forget webhook POSTs (Slack/Teams) on block and queue events |
| `cordon_sdk.py` | Python client library with automatic HITL retry loop |
| `policy.yaml` | YAML policy — hot-reloaded on every request |
| `policy.rego` | OPA Rego policy — argument-level rules, loaded by OPA server |

---

## Database Schema

### `audit_log`

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER / BIGSERIAL | Primary key |
| `timestamp` | TEXT | ISO-8601 UTC |
| `tool_name` | TEXT | MCP tool name |
| `method` | TEXT | JSON-RPC method |
| `action` | TEXT | ALLOW / BLOCK / REQUIRE_APPROVAL |
| `reason` | TEXT | Human-readable policy reason |
| `request_id` | TEXT | JSON-RPC request id |
| `client_ip` | TEXT | Agent IP address |
| `user_email` | TEXT | Authenticated user (OIDC) |

### `approval_queue`

| Column | Type | Description |
|---|---|---|
| `id` | TEXT | UUID approval key |
| `timestamp` | TEXT | ISO-8601 UTC when queued |
| `tool_name` | TEXT | MCP tool name |
| `arguments` | TEXT | JSON (PII-redacted) |
| `request_id` | TEXT | JSON-RPC request id |
| `client_ip` | TEXT | Agent IP address |
| `status` | TEXT | PENDING / APPROVED / REJECTED |
| `resolved_at` | TEXT | ISO-8601 UTC when resolved |
| `resolved_by` | TEXT | Operator email or "admin" |

---

## Auth Priority

```
Is OIDC_ISSUER + CLIENT_ID + CLIENT_SECRET all set?
  YES ──▶ OIDC/PKCE flow (Azure AD, Okta, etc.)
  NO
    Is CORDON_DASHBOARD_KEY set?
      YES ──▶ shared-key cookie auth
      NO  ──▶ open / dev mode (no auth)
```

---

## Policy Evaluation Priority

```
Is CORDON_OPA_URL set?
  YES ──▶ POST to OPA → use result
          (on any error: timeout, ConnectError) ──▶ fallback
  NO / fallback ──▶ linear scan of policy.yaml rules → default_action
```

---

## Deployment Topologies

### Single container (dev / small teams)
```
Agent → Cordon (SQLite, YAML policy)
```

### Docker Compose (recommended for on-prem)
```
Agent → Cordon ─── OPA sidecar (Rego policy)
                └── mock-mcp-server (for testing)
```

### Kubernetes / Helm (enterprise)
```
Agent → Ingress → Cordon pod ─── OPA sidecar
                               └── Postgres (external)
```
