# Policy Engine

Cordon supports two policy backends. OPA is evaluated first when configured; `policy.yaml` is always the fallback.

---

## YAML Policy

`policy.yaml` is hot-reloaded on every request — edit it and the next call picks up the change with no restart.

### Schema

```yaml
version: "1.0"

# Default action when no rule matches: ALLOW | BLOCK | REQUIRE_APPROVAL
default_action: ALLOW

rules:
  - tool: <tool_name>       # exact match against the MCP tool name
    action: <action>        # ALLOW | BLOCK | REQUIRE_APPROVAL
    reason: <string>        # shown to the agent and stored in the audit log
```

### Example

```yaml
version: "1.0"
default_action: ALLOW

rules:
  # Hard block — no human can override
  - tool: delete_file
    action: BLOCK
    reason: Destructive file operations are restricted.

  # Send to human approval queue
  - tool: execute_shell
    action: REQUIRE_APPROVAL
    reason: Shell commands require human oversight.

  - tool: restart_service
    action: REQUIRE_APPROVAL
    reason: Service restarts require operator sign-off.

  # Read-only enforcement
  - tool: write_historian
    action: BLOCK
    reason: EMS historian writes are read-only via this gateway.
```

### Limitations

YAML rules match on **tool name only**. For argument-level rules (e.g. block queries against specific tables), use OPA.

---

## OPA / Rego Policy

Set `CORDON_OPA_URL=http://opa:8181` to enable OPA. Cordon sends every `tools/call` to OPA before evaluating `policy.yaml`.

### Input schema

```json
{
  "input": {
    "tool":      "run_query",
    "arguments": { "table": "SCADA_RTU", "limit": 100 },
    "client_ip": "10.0.0.5"
  }
}
```

### Expected output

OPA must publish a `decision` rule under the `cordon` package:

```rego
package cordon

default decision = {"action": "ALLOW", "reason": ""}
```

Cordon reads `result.action` and `result.reason` from the response.

### Example policy

```rego
package cordon

default decision = {"action": "ALLOW", "reason": ""}

# Block destructive file operations
decision = {"action": "BLOCK", "reason": "Destructive file operations are restricted."} {
    input.tool == "delete_file"
}

# Block direct SCADA table access
decision = {"action": "BLOCK", "reason": "Direct SCADA table access is prohibited."} {
    input.tool == "run_query"
    startswith(input.arguments.table, "SCADA_")
}

# Block historian writes
decision = {"action": "BLOCK", "reason": "EMS historian writes are read-only."} {
    input.tool == "write_historian"
}

# Require approval for shell commands
decision = {"action": "REQUIRE_APPROVAL", "reason": "Shell commands require human oversight."} {
    input.tool == "execute_shell"
}

# Require approval for service restarts
decision = {"action": "REQUIRE_APPROVAL", "reason": "Service restarts require operator sign-off."} {
    input.tool == "restart_service"
}
```

### Fallback behaviour

If OPA is unreachable (network error, timeout, any exception), Cordon logs a warning and falls back to `policy.yaml`. OPA being down never causes calls to fail — it degrades gracefully.

### Running OPA locally

```bash
# Docker
docker run -p 8181:8181 -v $(pwd)/policy.rego:/policy.rego \
  openpolicyagent/opa run --server --addr 0.0.0.0:8181 /policy.rego

# Docker Compose (already configured)
docker compose up opa
```

Test a decision directly:

```bash
curl -s -X POST http://localhost:8181/v1/data/cordon/decision \
  -H 'Content-Type: application/json' \
  -d '{"input": {"tool": "delete_file", "arguments": {}}}'
```
