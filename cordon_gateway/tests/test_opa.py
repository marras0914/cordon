"""
OPA integration tests.
Uses unittest.mock to simulate OPA responses without a running OPA server.
Also tests YAML fallback when OPA is unavailable.
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import main
import db


TOOL_CALL = lambda tool, args=None, req_id=1: {
    "jsonrpc": "2.0",
    "id": req_id,
    "method": "tools/call",
    "params": {"name": tool, "arguments": args or {}},
}


def opa_response(action: str, reason: str = ""):
    """Build a mock httpx response that looks like an OPA decision."""
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"result": {"action": action, "reason": reason}}
    post_mock = AsyncMock(return_value=mock_resp)
    return post_mock


class TestOpaIntegration:
    def test_opa_block_decision_is_respected(self, client, monkeypatch):
        monkeypatch.setattr(main, "OPA_URL", "http://opa:8181")
        with patch("httpx.AsyncClient.post",
                   new=opa_response("BLOCK", "OPA says no.")):
            r = client.post("/messages", json=TOOL_CALL("any_tool"))
        assert r.json()["error"]["code"] == -32001
        assert "OPA says no." in r.json()["error"]["message"]

    def test_opa_require_approval_decision_is_respected(self, client, monkeypatch):
        monkeypatch.setattr(main, "OPA_URL", "http://opa:8181")
        with patch("httpx.AsyncClient.post",
                   new=opa_response("REQUIRE_APPROVAL", "OPA wants a human.")):
            r = client.post("/messages", json=TOOL_CALL("any_tool"))
        assert r.json()["error"]["code"] == -32002

    def test_opa_allow_forwards_to_backend(self, client, monkeypatch):
        monkeypatch.setattr(main, "OPA_URL", "http://opa:8181")

        opa_resp = MagicMock()
        opa_resp.json.return_value = {"result": {"action": "ALLOW", "reason": ""}}

        backend_resp = MagicMock()
        backend_resp.json.return_value = {"jsonrpc": "2.0", "id": 1,
                                          "result": {"output": "done"}}

        call_count = 0
        async def multi_post(url, **kwargs):
            nonlocal call_count
            call_count += 1
            if "opa" in url or "v1/data" in url:
                return opa_resp
            return backend_resp

        with patch("httpx.AsyncClient.post", side_effect=multi_post):
            r = client.post("/messages", json=TOOL_CALL("safe_tool"))
        assert r.json()["result"]["output"] == "done"

    def test_opa_passes_arguments_in_input(self, client, monkeypatch):
        """Verify the input sent to OPA includes tool name and arguments."""
        monkeypatch.setattr(main, "OPA_URL", "http://opa:8181")
        captured = {}

        backend_resp = MagicMock()
        backend_resp.json.return_value = {"jsonrpc": "2.0", "id": 1, "result": {}}

        async def post_router(url, **kwargs):
            if "v1/data" in url:
                captured.update(kwargs.get("json", {}))
                resp = MagicMock()
                resp.json.return_value = {"result": {"action": "ALLOW", "reason": ""}}
                return resp
            return backend_resp

        with patch("httpx.AsyncClient.post", side_effect=post_router):
            client.post("/messages",
                        json=TOOL_CALL("run_query", args={"table": "SCADA_METERS"}))

        assert captured.get("input", {}).get("tool") == "run_query"
        assert captured.get("input", {}).get("arguments", {}).get("table") == "SCADA_METERS"


class TestOpaFallback:
    def test_falls_back_to_yaml_on_connect_error(self, client, monkeypatch):
        """When OPA is unreachable, YAML policy still enforces rules."""
        monkeypatch.setattr(main, "OPA_URL", "http://opa:8181")
        import httpx as _httpx
        with patch("httpx.AsyncClient.post",
                   side_effect=_httpx.ConnectError("OPA down")):
            r = client.post("/messages", json=TOOL_CALL("delete_file"))
        # YAML policy should have blocked delete_file
        assert r.json()["error"]["code"] == -32001

    def test_falls_back_to_yaml_on_timeout(self, client, monkeypatch):
        monkeypatch.setattr(main, "OPA_URL", "http://opa:8181")
        import httpx as _httpx
        with patch("httpx.AsyncClient.post",
                   side_effect=_httpx.TimeoutException("timeout")):
            r = client.post("/messages", json=TOOL_CALL("delete_file"))
        assert r.json()["error"]["code"] == -32001

    def test_no_opa_url_uses_yaml_directly(self, client, monkeypatch):
        """When CORDON_OPA_URL is empty, never calls httpx for policy."""
        monkeypatch.setattr(main, "OPA_URL", "")
        with patch("httpx.AsyncClient.post") as mock_post:
            client.post("/messages", json=TOOL_CALL("delete_file"))
            # httpx should NOT have been called for OPA (only potentially for backend)
            # delete_file is blocked before backend forward, so no calls at all
            mock_post.assert_not_called()
