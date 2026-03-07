# Cordon — MCP Security Gateway

**Policy-as-Code reverse proxy for Model Context Protocol servers.**

Cordon sits between AI agents and your MCP tools. Every tool call is inspected, evaluated against policy, and either forwarded, blocked, or held for human approval — with a full audit trail.

---

## Why Cordon

MCP servers give AI agents real power: reading files, running queries, restarting services. Most deployments have no guardrails. Cordon adds:

- **Policy enforcement** — block or gate any tool by name or argument value
- **Human-in-the-Loop approvals** — pause sensitive calls until an operator signs off
- **Audit log** — every call logged with action, reason, user, and IP
- **PII redaction** — scrub emails, SSNs, credit cards before they hit storage
- **Rate limiting** — per-client call throttling to prevent agent runaway
- **Webhook alerting** — Slack/Teams notifications on blocks and queue buildup
- **NERC CIP compliance export** — CIP-007-6 R6 / CIP-005-7 R2 audit reports

---

## Architecture

```
 AI Agent (Claude, Cursor, etc.)
        |
        | MCP over HTTP/SSE
        v
 +------+----------+
 |   Cordon        |   Policy evaluation (YAML or OPA Rego)
 |   Gateway       |   PII redaction
 |   :8000         |   Rate limiting
 |                 |   Audit logging
 |   Dashboard     |   HITL approval queue
 |   /dashboard    |
 +------+----------+
        |
        | forwarded (ALLOW / post-approval)
        v
 Real MCP Server (:8001)
```

**Traffic flow:**

1. Agent connects to Cordon's SSE endpoint (`GET /sse`)
2. Agent sends a `tools/call` JSON-RPC message (`POST /messages`)
3. Cordon checks the rate limit, then evaluates policy (OPA first, YAML fallback)
4. `ALLOW` → forwarded to the real MCP server
5. `BLOCK` → JSON-RPC error returned immediately, event logged, webhook fired
6. `REQUIRE_APPROVAL` → queued with a UUID; agent retries with `X-Cordon-Approval-Id` header after operator approves at `/dashboard/approvals`

---

## Quick Start

### Docker Compose (recommended)

```bash
git clone <repo>
cd cordon_gateway

# Start Cordon + OPA + a mock MCP server
docker compose up --build
```

- Gateway: `http://localhost:8000`
- Dashboard: `http://localhost:8000/dashboard`
- OPA: `http://localhost:8181`

Point your AI client at `http://localhost:8000` instead of your real MCP server.

### Without Docker

```bash
cd cordon_gateway
pip install -r requirements.txt

REAL_MCP_SERVER=http://your-mcp-server:8001 \
  uvicorn main:app --host 0.0.0.0 --port 8000
```

---

## Configuration

All configuration is via environment variables.

### Core

| Variable | Default | Description |
|---|---|---|
| `REAL_MCP_SERVER` | `http://localhost:8001` | Upstream MCP server to proxy to |
| `CORDON_DB` | `cordon_audit.db` | SQLite database path (ignored if `DATABASE_URL` is set) |
| `DATABASE_URL` | _(empty)_ | PostgreSQL connection string — overrides SQLite |

### Policy

| Variable | Default | Description |
|---|---|---|
| `CORDON_OPA_URL` | _(empty)_ | OPA server URL, e.g. `http://opa:8181`. Unset = YAML-only mode |

### Rate Limiting

| Variable | Default | Description |
|---|---|---|
| `CORDON_RATE_LIMIT` | `60` | Max tool calls per window per client IP. `0` = disabled |
| `CORDON_RATE_WINDOW` | `60` | Sliding window size in seconds |

### PII Redaction

| Variable | Default | Description |
|---|---|---|
| `CORDON_REDACT_PII` | `true` | Redact PII from stored arguments (`true`/`false`) |

### Dashboard Auth

| Variable | Default | Description |
|---|---|---|
| `CORDON_DASHBOARD_KEY` | _(empty)_ | Shared key for dashboard login. Unset = open (dev only) |
| `CORDON_SESSION_SECRET` | _(auto)_ | Session cookie signing key. **Set this in production.** |

### OIDC / SSO (optional)

When all three OIDC variables are set, OIDC takes priority over the dashboard key.

| Variable | Description |
|---|---|
| `CORDON_OIDC_ISSUER` | IdP discovery URL, e.g. `https://login.microsoftonline.com/{tenant}/v2.0` |
| `CORDON_OIDC_CLIENT_ID` | Application client ID |
| `CORDON_OIDC_CLIENT_SECRET` | Application client secret |
| `CORDON_OIDC_REDIRECT_URI` | Callback URL, e.g. `https://cordon.example.com/dashboard/auth/callback` |
| `CORDON_OIDC_SCOPES` | Space-separated scopes (default: `openid email profile`) |

### Alerting

| Variable | Default | Description |
|---|---|---|
| `CORDON_WEBHOOK_URL` | _(empty)_ | Slack/Teams incoming webhook URL. Unset = disabled |
| `CORDON_ALERT_ON_BLOCK` | `true` | Fire webhook on every BLOCK decision |
| `CORDON_ALERT_QUEUE_THRESHOLD` | `5` | Fire webhook when pending approvals reach this count. `0` = disabled |

---

## Policy Engine

### YAML (default)

Edit `policy.yaml`. Changes are picked up on the next request — no restart needed.

```yaml
version: "1.0"
default_action: ALLOW   # ALLOW | BLOCK | REQUIRE_APPROVAL

rules:
  - tool: delete_file
    action: BLOCK
    reason: Destructive file operations are restricted.

  - tool: execute_shell
    action: REQUIRE_APPROVAL
    reason: Shell commands require human oversight.

  - tool: write_historian
    action: BLOCK
    reason: EMS historian writes are read-only via this gateway.
```

### OPA / Rego (recommended for production)

Set `CORDON_OPA_URL=http://opa:8181`. Cordon sends each tool call to OPA and falls back to `policy.yaml` if OPA is unreachable.

OPA receives:

```json
{
  "input": {
    "tool": "run_query",
    "arguments": { "table": "SCADA_RTU" },
    "client_ip": "10.0.0.5"
  }
}
```

Expected response: `{ "result": { "action": "BLOCK", "reason": "..." } }`

See [`policy.rego`](policy.rego) for a full example with argument-level rules (e.g. block queries against `SCADA_*` tables).

---

## HITL Approvals

When a tool matches `REQUIRE_APPROVAL`:

1. Cordon queues the call and returns a `-32002` error with a UUID:
   ```json
   { "error": { "code": -32002, "message": "...X-Cordon-Approval-Id: <uuid>" } }
   ```

2. The operator approves or rejects at `http://localhost:8000/dashboard/approvals`

3. The agent retries with the header:
   ```
   X-Cordon-Approval-Id: <uuid>
   ```

4. Cordon checks the status and either forwards the call or returns a final rejection.

---

## Dashboard

Available at `/dashboard`.

| Page | Description |
|---|---|
| `/dashboard/` | Audit log — live feed of every tool call |
| `/dashboard/approvals` | Pending approval queue + history |
| `/dashboard/policy` | Live policy.yaml editor |
| `/dashboard/export` | NERC CIP compliance export (CSV or JSON) |

---

## SDK

Use the Cordon SDK to call tools from Python without managing the approval retry loop yourself.

```python
import asyncio
from cordon_sdk import CordonClient, PolicyBlocked, ApprovalTimeout

async def main():
    async with CordonClient("http://localhost:8000") as cordon:
        try:
            result = await cordon.call_tool(
                "read_file",
                {"path": "/etc/hosts"},
                approval_timeout=300,   # wait up to 5 min for human approval
            )
            print(result)
        except PolicyBlocked as e:
            print(f"Blocked: {e.reason}")
        except ApprovalTimeout:
            print("Nobody approved in time.")

asyncio.run(main())
```

**Exceptions:**

| Exception | When raised |
|---|---|
| `PolicyBlocked` | Tool was blocked by policy |
| `ApprovalRejected` | Operator rejected the request |
| `ApprovalTimeout` | `approval_timeout` elapsed with no decision |
| `RateLimited` | Gateway rate limit exceeded |
| `CordonError` | Any other gateway error |

---

## Kubernetes / Helm

```bash
helm install cordon ./helm/cordon \
  --set gateway.realMcpServer=http://your-mcp-server:8001 \
  --set auth.dashboardKey=changeme \
  --set auth.sessionSecret=changeme
```

Key chart values:

```yaml
gateway:
  image:
    repository: your-registry/cordon-gateway
    tag: "0.1.0"
  realMcpServer: "http://your-mcp-server:8001"

opa:
  enabled: true          # runs as a sidecar

database:
  url: ""                # set to postgres:// for Postgres; leave blank for SQLite PVC

auth:
  dashboardKey: ""
  sessionSecret: ""
  oidc:
    enabled: false

ingress:
  enabled: false
  host: cordon.example.com
```

See [`helm/cordon/values.yaml`](helm/cordon/values.yaml) for all options.

---

## NERC CIP Compliance Export

At `/dashboard/export`, download a filtered audit report for NERC CIP-007-6 R6 (Security Event Monitoring) and CIP-005-7 R2 (Interactive Remote Access).

- **CSV** — comment header with standard reference, generated timestamp, and period. Compatible with NERC audit tooling.
- **JSON** — structured `meta` block + `records` array. Suitable for SIEM ingestion.

Filter by date range via `?start=YYYY-MM-DD&end=YYYY-MM-DD`.

---

## Development

```bash
cd cordon_gateway
pip install -r requirements.txt

# Run tests
python -m pytest tests/ -v

# Start with auto-reload
uvicorn main:app --reload --port 8000
```

---

## Production Checklist

- [ ] Set `CORDON_SESSION_SECRET` to a strong random string
- [ ] Set `CORDON_DASHBOARD_KEY` or configure OIDC
- [ ] Use `DATABASE_URL` (Postgres) instead of SQLite for multi-replica deployments
- [ ] Set `CORDON_WEBHOOK_URL` for block/queue alerting
- [ ] Review and harden `policy.yaml` / `policy.rego`
- [ ] Enable TLS via ingress or load balancer
- [ ] Set `CORDON_RATE_LIMIT` appropriate for your agent workload
