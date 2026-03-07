# Cordon Helm Chart

Deploys the Cordon MCP Security Gateway with an optional OPA sidecar.

## Install

```bash
helm repo add cordon https://YOUR_ORG.github.io/cordon
helm install cordon cordon/cordon \
  --set gateway.realMcpServer=http://your-mcp-server:8001 \
  --set auth.dashboardKey=changeme \
  --set auth.sessionSecret=changeme
```

## Upgrade

```bash
helm upgrade cordon cordon/cordon -f my-values.yaml
```

## Key values

| Value | Default | Description |
|---|---|---|
| `gateway.realMcpServer` | `http://your-mcp-server:8001` | Upstream MCP server |
| `opa.enabled` | `true` | Run OPA as a sidecar |
| `database.url` | `""` | Postgres URL; blank = SQLite PVC |
| `auth.dashboardKey` | `""` | Dashboard shared key |
| `auth.sessionSecret` | `""` | Session signing key (required in prod) |
| `ingress.enabled` | `false` | Enable nginx ingress |

See [values.yaml](values.yaml) for all options and [docs/helm.md](../../docs/helm.md) for full documentation.
