"""Tests for the Cordon SDK client."""
import asyncio
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
import httpx

import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from cordon_sdk import (
    CordonClient,
    PolicyBlocked,
    ApprovalRejected,
    ApprovalTimeout,
    RateLimited,
    CordonError,
    _parse_approval_id,
    _parse_retry_after,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _response(body: dict, status: int = 200) -> httpx.Response:
    import json
    return httpx.Response(status_code=status, content=json.dumps(body).encode(),
                          headers={"content-type": "application/json"})


def _mock_client(responses: list) -> AsyncMock:
    """Build an AsyncMock httpx.AsyncClient that returns responses in order."""
    mock = AsyncMock()
    mock.post = AsyncMock(side_effect=[_response(r) for r in responses])
    return mock


# ── _parse_approval_id ────────────────────────────────────────────────────────

class TestParseApprovalId:
    def test_extracts_uuid(self):
        msg = "Approval required. Retry with header X-Cordon-Approval-Id: 550e8400-e29b-41d4-a716-446655440000"
        assert _parse_approval_id(msg) == "550e8400-e29b-41d4-a716-446655440000"

    def test_returns_none_when_absent(self):
        assert _parse_approval_id("no uuid here") is None

    def test_case_insensitive(self):
        msg = "x-cordon-approval-id: 550e8400-e29b-41d4-a716-446655440000"
        assert _parse_approval_id(msg) == "550e8400-e29b-41d4-a716-446655440000"


class TestParseRetryAfter:
    def test_extracts_seconds(self):
        assert _parse_retry_after("rate limit exceeded. Retry after 30s.") == 30

    def test_returns_zero_when_absent(self):
        assert _parse_retry_after("no number here") == 0


# ── call_tool — success ───────────────────────────────────────────────────────

class TestCallToolSuccess:
    def test_returns_result_on_200(self):
        async def run():
            client = CordonClient("http://localhost:8000")
            client._client = _mock_client([
                {"jsonrpc": "2.0", "id": 1, "result": {"content": "file content"}}
            ])
            result = await client.call_tool("read_file", {"path": "/etc/hosts"})
            assert result == {"content": "file content"}

        asyncio.run(run())

    def test_sends_correct_method(self):
        async def run():
            mock = AsyncMock()
            mock.post = AsyncMock(return_value=_response(
                {"jsonrpc": "2.0", "id": 1, "result": {}}
            ))
            client = CordonClient("http://localhost:8000")
            client._client = mock
            await client.call_tool("my_tool", {"arg": "val"})
            payload = mock.post.call_args[1]["json"]
            assert payload["method"] == "tools/call"
            assert payload["params"]["name"] == "my_tool"
            assert payload["params"]["arguments"] == {"arg": "val"}

        asyncio.run(run())

    def test_posts_to_messages_endpoint(self):
        async def run():
            mock = AsyncMock()
            mock.post = AsyncMock(return_value=_response(
                {"jsonrpc": "2.0", "id": 1, "result": {}}
            ))
            client = CordonClient("http://mygateway:9000")
            client._client = mock
            await client.call_tool("t", {})
            url = mock.post.call_args[0][0]
            assert url == "http://mygateway:9000/messages"

        asyncio.run(run())


# ── call_tool — BLOCK ─────────────────────────────────────────────────────────

class TestCallToolBlock:
    def test_raises_policy_blocked(self):
        async def run():
            client = CordonClient("http://localhost:8000")
            client._client = _mock_client([
                {"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32001, "message": "Cordon Policy Violation: Not allowed"}}
            ])
            with pytest.raises(PolicyBlocked) as exc_info:
                await client.call_tool("delete_file", {})
            assert exc_info.value.tool_name == "delete_file"

        asyncio.run(run())

    def test_policy_blocked_includes_reason(self):
        async def run():
            client = CordonClient("http://localhost:8000")
            client._client = _mock_client([
                {"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32001, "message": "Destructive operation blocked"}}
            ])
            with pytest.raises(PolicyBlocked) as exc_info:
                await client.call_tool("delete_file", {})
            assert "Destructive operation blocked" in str(exc_info.value)

        asyncio.run(run())


# ── call_tool — RATE LIMITED ──────────────────────────────────────────────────

class TestCallToolRateLimited:
    def test_raises_rate_limited(self):
        async def run():
            client = CordonClient("http://localhost:8000")
            client._client = _mock_client([
                {"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32005, "message": "rate limit exceeded. Retry after 30s."}}
            ])
            with pytest.raises(RateLimited) as exc_info:
                await client.call_tool("read_file", {})
            assert exc_info.value.retry_after == 30

        asyncio.run(run())


# ── call_tool — HITL approval ─────────────────────────────────────────────────

_APPROVAL_ID = "550e8400-e29b-41d4-a716-446655440000"
_APPROVAL_MSG = f"Approval required. Retry with header X-Cordon-Approval-Id: {_APPROVAL_ID}"


class TestCallToolApproval:
    def test_polls_and_succeeds_on_approval(self):
        async def run():
            client = CordonClient("http://localhost:8000", poll_interval=0)
            client._client = _mock_client([
                # First call: queued
                {"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32002, "message": _APPROVAL_MSG}},
                # Second call (with header): still pending
                {"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32002, "message": _APPROVAL_MSG}},
                # Third call: approved → success
                {"jsonrpc": "2.0", "id": 1, "result": {"ok": True}},
            ])
            result = await client.call_tool("execute_shell", {"cmd": "ls"}, approval_timeout=60)
            assert result == {"ok": True}

        asyncio.run(run())

    def test_sends_approval_id_header_on_retry(self):
        async def run():
            mock = AsyncMock()
            responses = [
                _response({"jsonrpc": "2.0", "id": 1,
                           "error": {"code": -32002, "message": _APPROVAL_MSG}}),
                _response({"jsonrpc": "2.0", "id": 1, "result": {}}),
            ]
            mock.post = AsyncMock(side_effect=responses)
            client = CordonClient("http://localhost:8000", poll_interval=0)
            client._client = mock
            await client.call_tool("execute_shell", {}, approval_timeout=60)
            second_call_headers = mock.post.call_args_list[1][1]["headers"]
            assert second_call_headers.get("X-Cordon-Approval-Id") == _APPROVAL_ID

        asyncio.run(run())

    def test_raises_approval_timeout(self):
        async def run():
            # All responses are still-pending
            client = CordonClient("http://localhost:8000", poll_interval=0)
            pending = {"jsonrpc": "2.0", "id": 1,
                       "error": {"code": -32002, "message": _APPROVAL_MSG}}
            client._client = _mock_client([pending] * 20)
            with pytest.raises(ApprovalTimeout) as exc_info:
                await client.call_tool("execute_shell", {}, approval_timeout=0)
            assert exc_info.value.approval_id == _APPROVAL_ID

        asyncio.run(run())

    def test_raises_cordon_error_on_unparseable_approval_id(self):
        async def run():
            client = CordonClient("http://localhost:8000", poll_interval=0)
            client._client = _mock_client([
                {"jsonrpc": "2.0", "id": 1,
                 "error": {"code": -32002, "message": "Approval required. No UUID here."}}
            ])
            with pytest.raises(CordonError):
                await client.call_tool("execute_shell", {}, approval_timeout=60)

        asyncio.run(run())


# ── context manager ───────────────────────────────────────────────────────────

class TestContextManager:
    def test_async_context_manager(self):
        async def run():
            async with CordonClient("http://localhost:8000") as c:
                assert isinstance(c, CordonClient)

        asyncio.run(run())
