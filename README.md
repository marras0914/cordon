# Cordon

**Policy-as-Code MCP Security Gateway**

Cordon sits between your AI agent and any MCP tool server, enforcing ALLOW / BLOCK / REQUIRE_APPROVAL policies with a full audit trail, human-in-the-loop approval queue, PII redaction, rate limiting, and webhook alerting.

```
AI Agent  →  Cordon Gateway  →  MCP Tool Server
                   ↓
            Policy Engine (YAML or OPA)
            Audit Log (SQLite / Postgres)
            Dashboard + Approvals UI
```

## Quick Start

```bash
# 1. Point at your MCP server
export REAL_MCP_SERVER=http://your-mcp-server:8001

# 2. Run with Docker
docker run -p 8000:8000 \
  -e REAL_MCP_SERVER=$REAL_MCP_SERVER \
  ghcr.io/marras0914/cordon-gateway:latest

# 3. Configure your agent to use http://localhost:8000 instead
```

## Policy

Drop a `policy.yaml` and mount it at `/app/policy.yaml`:

```yaml
version: "1.0"
default_action: ALLOW
rules:
  - tool: delete_file
    action: BLOCK
    reason: Destructive operations are restricted.
  - tool: execute_shell
    action: REQUIRE_APPROVAL
    reason: Shell commands require human sign-off.
```

Actions: `ALLOW` · `BLOCK` · `REQUIRE_APPROVAL`

OPA is also supported — set `CORDON_OPA_URL=http://opa:8181` to use a Rego policy instead.

## Human-in-the-Loop Approvals

When a tool is blocked pending approval, Cordon returns:

```json
{ "error": { "code": -32002, "message": "Approval required. Retry with header X-Cordon-Approval-Id: <uuid>" } }
```

The operator approves or rejects at `/dashboard/approvals`. The agent retries with the `X-Cordon-Approval-Id` header and proceeds automatically.

## SDK

```bash
npm install cordon-sdk
```

```ts
import { CordonClient } from "cordon-sdk";

const client = new CordonClient({ baseUrl: "http://localhost:8000" });
const result = await client.callTool("read_file", { path: "/etc/hosts" });
// HITL approval loop handled automatically
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REAL_MCP_SERVER` | `http://localhost:8001` | Upstream MCP server |
| `CORDON_OPA_URL` | — | Enable OPA policy engine |
| `CORDON_REDACT_PII` | `true` | Scrub PII before logging |
| `CORDON_RATE_LIMIT` | `60` | Requests/window per IP (0 = off) |
| `CORDON_RATE_WINDOW` | `60` | Window size in seconds |
| `CORDON_WEBHOOK_URL` | — | Slack/Teams alert webhook |
| `CORDON_ALERT_ON_BLOCK` | `true` | Alert on every BLOCK |
| `CORDON_ALERT_QUEUE_THRESHOLD` | `5` | Alert when approval queue ≥ N |
| `CORDON_DASHBOARD_KEY` | — | Shared-key auth for dashboard |
| `DATABASE_URL` | — | Postgres URL (default: SQLite) |
| `PORT` | `8000` | Listen port |

## JSON-RPC Error Codes

| Code | Meaning |
|---|---|
| `-32001` | BLOCK — policy violation or operator rejection |
| `-32002` | REQUIRE_APPROVAL — retry with approval ID header |
| `-32003` | Backend unreachable |
| `-32005` | Rate limit exceeded |

## Helm

```bash
helm repo add cordon https://marras0914.github.io/cordon
helm install cordon cordon/cordon \
  --set env.REAL_MCP_SERVER=http://your-mcp:8001
```

## Development

```bash
# Run tests
npm test --prefix packages/gateway   # 56 tests
npm test --prefix packages/sdk       # 13 tests

# Lint
npx @biomejs/biome@1.9.4 check packages/

# Local stack
docker compose up
```

## Repo Layout

```
packages/
  gateway/          # Hono gateway (TypeScript)
    src/
      proxy.ts      # SSE proxy + message interceptor
      policy.ts     # YAML + OPA policy engine
      pii.ts        # PII redaction
      rate-limit.ts # Sliding window rate limiter
      alerting.ts   # Webhook alerting
      db.ts         # SQLite / Postgres audit log
      dashboard/    # Web UI (approvals, audit log, policy editor)
    test/           # 56 Vitest tests
  sdk/              # cordon-sdk npm package (TypeScript)
helm/cordon/        # Helm chart
```

## License

MIT
