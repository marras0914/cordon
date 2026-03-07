"""
Gateway policy enforcement and HITL flow tests.
Backend (REAL_MCP_SERVER) is mocked via unittest.mock so no real server is needed.
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

import db

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

TOOL_CALL = lambda tool, args=None, req_id=1: {
    "jsonrpc": "2.0",
    "id": req_id,
    "method": "tools/call",
    "params": {"name": tool, "arguments": args or {}},
}

def mock_backend(data: dict):
    """Return an AsyncMock that simulates a successful httpx backend response."""
    resp = MagicMock()
    resp.json.return_value = data
    post_mock = AsyncMock(return_value=resp)
    return post_mock


# ---------------------------------------------------------------------------
# BLOCK
# ---------------------------------------------------------------------------

class TestBlock:
    def test_blocked_tool_returns_32001(self, client):
        r = client.post("/messages", json=TOOL_CALL("delete_file"))
        assert r.status_code == 200
        body = r.json()
        assert body["error"]["code"] == -32001
        assert "Policy Violation" in body["error"]["message"]

    def test_blocked_tool_is_logged(self, client):
        client.post("/messages", json=TOOL_CALL("delete_file", req_id=42))
        logs = db.get_logs()
        assert logs[0]["action"] == "BLOCK"
        assert logs[0]["tool_name"] == "delete_file"
        assert logs[0]["request_id"] == "42"

    def test_blocked_tool_never_reaches_backend(self, client):
        with patch("httpx.AsyncClient.post") as mock_post:
            client.post("/messages", json=TOOL_CALL("delete_file"))
            mock_post.assert_not_called()


# ---------------------------------------------------------------------------
# ALLOW
# ---------------------------------------------------------------------------

class TestAllow:
    def test_allowed_tool_forwarded_to_backend(self, client):
        backend_reply = {"jsonrpc": "2.0", "id": 1, "result": {"content": "hello"}}
        with patch("httpx.AsyncClient.post", new_callable=lambda: lambda *a, **k: None) as _:
            with patch("httpx.AsyncClient.post", new=mock_backend(backend_reply)):
                r = client.post("/messages", json=TOOL_CALL("read_file"))
        assert r.status_code == 200
        assert r.json()["result"]["content"] == "hello"

    def test_backend_unreachable_returns_32003(self, client):
        import httpx
        with patch("httpx.AsyncClient.post", side_effect=httpx.ConnectError("no backend")):
            r = client.post("/messages", json=TOOL_CALL("read_file"))
        assert r.status_code == 502
        assert r.json()["error"]["code"] == -32003

    def test_non_tool_call_method_forwarded(self, client):
        backend_reply = {"jsonrpc": "2.0", "id": 5, "result": {"tools": []}}
        payload = {"jsonrpc": "2.0", "id": 5, "method": "tools/list", "params": {}}
        with patch("httpx.AsyncClient.post", new=mock_backend(backend_reply)):
            r = client.post("/messages", json=payload)
        assert r.status_code == 200
        assert r.json()["result"]["tools"] == []


# ---------------------------------------------------------------------------
# REQUIRE_APPROVAL
# ---------------------------------------------------------------------------

class TestRequireApproval:
    def test_first_call_returns_32002_with_approval_id(self, client):
        r = client.post("/messages", json=TOOL_CALL("execute_shell"))
        assert r.status_code == 200
        body = r.json()
        assert body["error"]["code"] == -32002
        assert "X-Cordon-Approval-Id" in body["error"]["message"]

    def test_first_call_creates_pending_queue_entry(self, client):
        client.post("/messages", json=TOOL_CALL("execute_shell", args={"cmd": "ls"}))
        pending = db.get_pending_approvals()
        assert len(pending) == 1
        assert pending[0]["tool_name"] == "execute_shell"
        assert pending[0]["status"] == "PENDING"
        assert json.loads(pending[0]["arguments"]) == {"cmd": "ls"}

    def test_first_call_is_logged_as_require_approval(self, client):
        client.post("/messages", json=TOOL_CALL("execute_shell"))
        logs = db.get_logs()
        assert logs[0]["action"] == "REQUIRE_APPROVAL"

    def test_retry_while_pending_returns_same_id(self, client):
        r1 = client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = r1.json()["error"]["message"].split("X-Cordon-Approval-Id: ")[1]

        r2 = client.post("/messages", json=TOOL_CALL("execute_shell"),
                         headers={"X-Cordon-Approval-Id": aid})
        assert r2.json()["error"]["code"] == -32002
        assert aid in r2.json()["error"]["message"]
        # Should NOT have created a second queue entry
        assert len(db.get_pending_approvals()) == 1

    def test_approved_retry_forwards_to_backend(self, client):
        r1 = client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = r1.json()["error"]["message"].split("X-Cordon-Approval-Id: ")[1]
        db.resolve_approval(aid, "APPROVED")

        backend_reply = {"jsonrpc": "2.0", "id": 1, "result": {"output": "ok"}}
        with patch("httpx.AsyncClient.post", new=mock_backend(backend_reply)):
            r2 = client.post("/messages", json=TOOL_CALL("execute_shell"),
                             headers={"X-Cordon-Approval-Id": aid})
        assert r2.status_code == 200
        assert r2.json()["result"]["output"] == "ok"

    def test_approved_retry_logged_as_allow(self, client):
        r1 = client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = r1.json()["error"]["message"].split("X-Cordon-Approval-Id: ")[1]
        db.resolve_approval(aid, "APPROVED")

        backend_reply = {"jsonrpc": "2.0", "id": 1, "result": {}}
        with patch("httpx.AsyncClient.post", new=mock_backend(backend_reply)):
            client.post("/messages", json=TOOL_CALL("execute_shell"),
                        headers={"X-Cordon-Approval-Id": aid})

        logs = db.get_logs()
        allow_log = next(l for l in logs if l["action"] == "ALLOW")
        assert allow_log["reason"] == "Human approved"

    def test_rejected_retry_returns_32001(self, client):
        r1 = client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = r1.json()["error"]["message"].split("X-Cordon-Approval-Id: ")[1]
        db.resolve_approval(aid, "REJECTED")

        r2 = client.post("/messages", json=TOOL_CALL("execute_shell"),
                         headers={"X-Cordon-Approval-Id": aid})
        assert r2.status_code == 200
        assert r2.json()["error"]["code"] == -32001
        assert "rejected" in r2.json()["error"]["message"]

    def test_rejected_retry_logged_as_block(self, client):
        r1 = client.post("/messages", json=TOOL_CALL("execute_shell"))
        aid = r1.json()["error"]["message"].split("X-Cordon-Approval-Id: ")[1]
        db.resolve_approval(aid, "REJECTED")

        client.post("/messages", json=TOOL_CALL("execute_shell"),
                    headers={"X-Cordon-Approval-Id": aid})

        logs = db.get_logs()
        block_log = next(l for l in logs if l["action"] == "BLOCK")
        assert block_log["reason"] == "Human rejected"

    def test_unknown_approval_id_creates_new_queue_entry(self, client):
        r = client.post("/messages", json=TOOL_CALL("execute_shell"),
                        headers={"X-Cordon-Approval-Id": "00000000-0000-0000-0000-000000000000"})
        assert r.json()["error"]["code"] == -32002
        # New entry queued (unknown ID treated as fresh request)
        assert len(db.get_pending_approvals()) == 1
