# Cordon OPA Policy
# -----------------
# Evaluated via POST /v1/data/cordon/decision with body:
#   {"input": {"tool": "<name>", "arguments": {...}, "client_ip": "<ip>"}}
#
# Returns: {"result": {"action": "ALLOW|BLOCK|REQUIRE_APPROVAL", "reason": "..."}}
#
# Rules are evaluated top-to-bottom. BLOCK takes priority over REQUIRE_APPROVAL.
# If no rule matches, the default (ALLOW) applies.

package cordon

default decision = {"action": "ALLOW", "reason": ""}

# ---------- BLOCK rules ----------

decision = {"action": "BLOCK", "reason": "Destructive file operations are restricted."} {
    input.tool == "delete_file"
}

decision = {"action": "BLOCK", "reason": "Direct SCADA table access is prohibited."} {
    input.tool == "run_query"
    startswith(input.arguments.table, "SCADA_")
}

decision = {"action": "BLOCK", "reason": "EMS historian writes are read-only via this gateway."} {
    input.tool == "write_historian"
}

# ---------- REQUIRE_APPROVAL rules ----------

decision = {"action": "REQUIRE_APPROVAL", "reason": "Shell commands require human oversight."} {
    input.tool == "execute_shell"
}

decision = {"action": "REQUIRE_APPROVAL", "reason": "Service restarts require operator sign-off."} {
    input.tool == "restart_service"
}

decision = {"action": "REQUIRE_APPROVAL", "reason": "Schema migrations require human approval."} {
    input.tool == "run_migration"
}
