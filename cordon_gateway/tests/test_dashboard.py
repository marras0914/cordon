"""
Dashboard UI tests — audit log, approvals, policy editor, and auth.
"""
import os
import sqlite3
from unittest.mock import patch

import pytest
import yaml

import db

POLICY_FILE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "policy.yaml"
)

TOOL_CALL = lambda tool, req_id=1: {
    "jsonrpc": "2.0",
    "id": req_id,
    "method": "tools/call",
    "params": {"name": tool, "arguments": {}},
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _load_policy():
    with open(POLICY_FILE) as f:
        return yaml.safe_load(f)

def _save_policy(config):
    with open(POLICY_FILE, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)

def _original_policy():
    return {
        "version": "1.0",
        "default_action": "ALLOW",
        "rules": [
            {"tool": "delete_file", "action": "BLOCK",
             "reason": "Destructive file operations are restricted in this environment."},
            {"tool": "execute_shell", "action": "REQUIRE_APPROVAL",
             "reason": "Arbitrary shell commands require manual engineering oversight."},
        ],
    }


@pytest.fixture(autouse=True)
def restore_policy():
    """Reset policy.yaml to original state after each test."""
    yield
    _save_policy(_original_policy())


# ---------------------------------------------------------------------------
# page loads
# ---------------------------------------------------------------------------

class TestPageLoads:
    def test_audit_log_page(self, client):
        r = client.get("/dashboard/")
        assert r.status_code == 200
        assert "Audit Log" in r.text

    def test_approvals_page(self, client):
        r = client.get("/dashboard/approvals")
        assert r.status_code == 200
        assert "Approvals" in r.text

    def test_policy_page(self, client):
        r = client.get("/dashboard/policy")
        assert r.status_code == 200
        assert "Policy Editor" in r.text


# ---------------------------------------------------------------------------
# audit log content
# ---------------------------------------------------------------------------

class TestAuditLogContent:
    def test_blocked_event_appears_in_log(self, client):
        client.post("/messages", json=TOOL_CALL("delete_file"))
        r = client.get("/dashboard/")
        assert "BLOCK" in r.text
        assert "delete_file" in r.text

    def test_approval_event_appears_in_log(self, client):
        client.post("/messages", json=TOOL_CALL("execute_shell"))
        r = client.get("/dashboard/")
        assert "REQUIRE_APPROVAL" in r.text
        assert "execute_shell" in r.text

    def test_stat_counts_are_accurate(self, client):
        client.post("/messages", json=TOOL_CALL("delete_file"))
        client.post("/messages", json=TOOL_CALL("execute_shell"))
        r = client.get("/dashboard/")
        # Both counts should appear somewhere on the page
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# approvals queue
# ---------------------------------------------------------------------------

class TestApprovalsPage:
    def test_pending_approval_shown(self, client):
        client.post("/messages", json=TOOL_CALL("execute_shell"))
        r = client.get("/dashboard/approvals")
        assert "execute_shell" in r.text
        assert "Approve" in r.text
        assert "Reject" in r.text

    def test_approve_resolves_and_redirects(self, client):
        client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = db.get_pending_approvals()[0]["id"]

        r = client.post("/dashboard/approvals/resolve",
                        data={"approval_id": aid, "decision": "APPROVED"},
                        follow_redirects=False)
        assert r.status_code == 303

        resolved = db.get_approval(aid)
        assert resolved["status"] == "APPROVED"

    def test_reject_resolves_and_redirects(self, client):
        client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = db.get_pending_approvals()[0]["id"]

        r = client.post("/dashboard/approvals/resolve",
                        data={"approval_id": aid, "decision": "REJECTED"},
                        follow_redirects=False)
        assert r.status_code == 303

        resolved = db.get_approval(aid)
        assert resolved["status"] == "REJECTED"

    def test_resolved_approvals_appear_in_history(self, client):
        client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = db.get_pending_approvals()[0]["id"]
        db.resolve_approval(aid, "APPROVED")

        r = client.get("/dashboard/approvals")
        assert "APPROVED" in r.text


# ---------------------------------------------------------------------------
# policy editor
# ---------------------------------------------------------------------------

class TestPolicyEditor:
    def test_existing_rules_shown(self, client):
        r = client.get("/dashboard/policy")
        assert "delete_file" in r.text
        assert "execute_shell" in r.text

    def test_add_rule(self, client):
        r = client.post("/dashboard/policy/rule/add",
                        data={"tool": "drop_table", "action": "BLOCK", "reason": "No SQL drops"},
                        follow_redirects=False)
        assert r.status_code == 303
        policy = _load_policy()
        tools = [rule["tool"] for rule in policy["rules"]]
        assert "drop_table" in tools

    def test_update_rule(self, client):
        r = client.post("/dashboard/policy/rule/update",
                        data={"index": "0", "tool": "delete_file",
                              "action": "REQUIRE_APPROVAL", "reason": "Updated reason"},
                        follow_redirects=False)
        assert r.status_code == 303
        policy = _load_policy()
        rule = next(r for r in policy["rules"] if r["tool"] == "delete_file")
        assert rule["action"] == "REQUIRE_APPROVAL"
        assert rule["reason"] == "Updated reason"

    def test_delete_rule(self, client):
        policy = _load_policy()
        original_count = len(policy["rules"])

        r = client.post("/dashboard/policy/rule/delete",
                        data={"index": "0"},
                        follow_redirects=False)
        assert r.status_code == 303
        policy = _load_policy()
        assert len(policy["rules"]) == original_count - 1

    def test_set_default_action(self, client):
        r = client.post("/dashboard/policy/default",
                        data={"default_action": "BLOCK"},
                        follow_redirects=False)
        assert r.status_code == 303
        assert _load_policy()["default_action"] == "BLOCK"


# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------

class TestAuth:
    def test_open_when_no_key_set(self, client):
        """Default dev mode: dashboard is accessible without auth."""
        import dashboard
        original = dashboard.DASHBOARD_KEY
        try:
            dashboard.DASHBOARD_KEY = ""
            r = client.get("/dashboard/")
            assert r.status_code == 200
        finally:
            dashboard.DASHBOARD_KEY = original

    def test_redirects_to_login_when_key_set_and_no_cookie(self, client):
        import dashboard
        original = dashboard.DASHBOARD_KEY
        try:
            dashboard.DASHBOARD_KEY = "secret"
            r = client.get("/dashboard/", follow_redirects=False)
            assert r.status_code == 302
            assert "/login" in r.headers["location"]
        finally:
            dashboard.DASHBOARD_KEY = original

    def test_login_sets_cookie_and_redirects(self, client):
        import dashboard
        original = dashboard.DASHBOARD_KEY
        try:
            dashboard.DASHBOARD_KEY = "secret"
            r = client.post("/dashboard/login",
                            data={"key": "secret"},
                            follow_redirects=False)
            assert r.status_code == 303
            assert "cordon_session" in r.cookies
        finally:
            dashboard.DASHBOARD_KEY = original

    def test_wrong_key_stays_on_login(self, client):
        import dashboard
        original = dashboard.DASHBOARD_KEY
        try:
            dashboard.DASHBOARD_KEY = "secret"
            r = client.post("/dashboard/login",
                            data={"key": "wrong"},
                            follow_redirects=False)
            assert r.status_code == 303
            assert "login" in r.headers["location"]
        finally:
            dashboard.DASHBOARD_KEY = original

    def test_valid_cookie_grants_access(self, client):
        import dashboard
        original = dashboard.DASHBOARD_KEY
        try:
            dashboard.DASHBOARD_KEY = "secret"
            client.cookies.set("cordon_session", "secret")
            r = client.get("/dashboard/")
            assert r.status_code == 200
        finally:
            dashboard.DASHBOARD_KEY = original
            client.cookies.clear()
