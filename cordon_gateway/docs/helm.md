# Helm Deployment

The Cordon Helm chart deploys the gateway and OPA sidecar to Kubernetes with configurable auth, storage, and ingress.

---

## Prerequisites

- Kubernetes 1.24+
- Helm 3.x
- `kubectl` configured for your cluster

---

## Install

```bash
helm install cordon ./helm/cordon \
  --set gateway.realMcpServer=http://your-mcp-server:8001 \
  --set auth.dashboardKey=your-strong-key \
  --set auth.sessionSecret=your-strong-secret
```

Cordon will be available at the ClusterIP service on port 8000.

---

## Upgrade

```bash
helm upgrade cordon ./helm/cordon -f my-values.yaml
```

---

## Uninstall

```bash
helm uninstall cordon
```

---

## Values reference

### Gateway

```yaml
gateway:
  image:
    repository: your-registry/cordon-gateway
    tag: "0.1.0"
    pullPolicy: IfNotPresent

  replicas: 1

  service:
    type: ClusterIP
    port: 8000

  realMcpServer: "http://your-mcp-server:8001"

  resources:
    requests:
      cpu: "100m"
      memory: "128Mi"
    limits:
      cpu: "500m"
      memory: "512Mi"
```

### OPA sidecar

```yaml
opa:
  enabled: true     # runs in the same pod as the gateway
  image:
    repository: openpolicyagent/opa
    tag: "latest"
  resources:
    requests:
      cpu: "50m"
      memory: "64Mi"
```

When `opa.enabled=true`, `CORDON_OPA_URL=http://localhost:8181` is injected automatically. The gateway and OPA share the pod network so no service is needed.

### Database

```yaml
database:
  # Leave blank to use SQLite with a PersistentVolumeClaim
  url: ""

  sqlite:
    storageClass: ""    # uses cluster default when blank
    storageSize: "1Gi"
```

For multi-replica or production deployments, use Postgres:

```yaml
database:
  url: "postgresql://cordon:password@postgres-service:5432/cordon"
```

When `database.url` is set, no PVC is created.

### Auth

```yaml
auth:
  dashboardKey: "your-strong-key"
  sessionSecret: "your-strong-secret"

  oidc:
    enabled: false
    issuer: ""
    clientId: ""
    clientSecret: ""
    redirectUri: ""
    scopes: "openid email profile"
```

### Ingress

```yaml
ingress:
  enabled: true
  className: "nginx"
  host: "cordon.example.com"
  tls:
    enabled: true
    secretName: "cordon-tls"
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
```

---

## Secrets management

All sensitive values (`dashboardKey`, `sessionSecret`, OIDC credentials, `database.url`) are stored in a Kubernetes Secret. For production, supply them via external secret management rather than plain `--set`:

```bash
# Using a values file (keep out of version control)
helm install cordon ./helm/cordon -f secrets-values.yaml

# Or with a pre-existing Secret (extend the chart's secret.yaml)
```

---

## Config change restarts

The deployment uses `checksum` annotations on the ConfigMap and Secret. When either changes during `helm upgrade`, Kubernetes automatically rolls the pods.

---

## Production checklist

- [ ] Push your image to a private registry and update `gateway.image.repository`
- [ ] Set `auth.dashboardKey` and `auth.sessionSecret` to strong random values
- [ ] Use `database.url` (Postgres) for any multi-replica deployment
- [ ] Enable `ingress` with TLS
- [ ] Pin `opa.image.tag` to a specific version (not `latest`)
- [ ] Set `gateway.replicas` > 1 only with Postgres (SQLite PVC is `ReadWriteOnce`)
