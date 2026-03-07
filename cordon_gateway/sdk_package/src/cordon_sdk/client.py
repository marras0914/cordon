"""
Cordon SDK — thin async client for the Cordon MCP Security Gateway.

Handles:
  - Transparent tool call proxying
  - Automatic HITL approval polling (retry loop with X-Cordon-Approval-Id header)
  - Typed exceptions for each failure mode
"""

import asyncio
import re
import httpx


# ---------- exceptions ----------

class CordonError(Exception):
    """Base class for all Cordon SDK errors."""


class PolicyBlocked(CordonError):
    """Tool call was blocked by Cordon policy."""
    def __init__(self, tool_name: str, reason: str):
        self.tool_name = tool_name
        self.reason = reason
        super().__init__(f"Policy blocked '{tool_name}': {reason}")


class ApprovalRejected(CordonError):
    """A human operator rejected the tool call."""
    def __init__(self, tool_name: str):
        self.tool_name = tool_name
        super().__init__(f"Operator rejected tool call: '{tool_name}'")


class ApprovalTimeout(CordonError):
    """Timed out waiting for a human operator to approve the tool call."""
    def __init__(self, tool_name: str, approval_id: str, timeout: int):
        self.tool_name = tool_name
        self.approval_id = approval_id
        self.timeout = timeout
        super().__init__(
            f"Approval timeout ({timeout}s) for '{tool_name}' "
            f"(approval_id={approval_id})"
        )


class RateLimited(CordonError):
    """The gateway rate-limited this client."""
    def __init__(self, retry_after: int):
        self.retry_after = retry_after
        super().__init__(f"Rate limited by Cordon. Retry after {retry_after}s.")


# ---------- client ----------

_JSONRPC_ID = 1


class CordonClient:
    """
    Async client for the Cordon MCP Security Gateway.

    Parameters
    ----------
    base_url:       Root URL of the Cordon gateway, e.g. "http://localhost:8000"
    poll_interval:  Seconds between approval status polls (default 5)
    http_timeout:   httpx request timeout in seconds (default 10)
    """

    def __init__(
        self,
        base_url: str,
        poll_interval: float = 5.0,
        http_timeout: float = 10.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.poll_interval = poll_interval
        self._client = httpx.AsyncClient(timeout=http_timeout)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        await self.aclose()

    async def aclose(self):
        await self._client.aclose()

    async def call_tool(
        self,
        tool_name: str,
        arguments: dict,
        *,
        approval_timeout: int = 300,
        request_id: int | str | None = None,
    ):
        """
        Call a tool through the Cordon gateway.

        Transparently handles the HITL approval loop: if the gateway returns
        REQUIRE_APPROVAL (-32002), this method polls until the operator
        approves or rejects, or until `approval_timeout` seconds elapse.

        Returns the tool result dict on success.
        Raises PolicyBlocked, ApprovalRejected, ApprovalTimeout, or RateLimited.
        """
        global _JSONRPC_ID
        if request_id is None:
            request_id = _JSONRPC_ID
            _JSONRPC_ID += 1

        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }

        approval_id, elapsed = None, 0

        while True:
            headers = {}
            if approval_id:
                headers["X-Cordon-Approval-Id"] = approval_id

            resp = await self._client.post(
                f"{self.base_url}/messages",
                json=payload,
                headers=headers,
            )
            body = resp.json()

            if "result" in body:
                return body["result"]

            error = body.get("error", {})
            code  = error.get("code")
            msg   = error.get("message", "")

            if code == -32001:
                raise PolicyBlocked(tool_name, msg)

            if code == -32005:
                raise RateLimited(_parse_retry_after(msg))

            if code == -32002:
                if approval_id is None:
                    approval_id = _parse_approval_id(msg)
                    if not approval_id:
                        raise CordonError(f"Could not parse approval_id from: {msg}")

                if elapsed >= approval_timeout:
                    raise ApprovalTimeout(tool_name, approval_id, approval_timeout)

                await asyncio.sleep(self.poll_interval)
                elapsed += self.poll_interval
                continue

            raise CordonError(f"Unexpected gateway error (code={code}): {msg}")


# ---------- helpers ----------

def _parse_approval_id(message: str) -> str | None:
    match = re.search(
        r"X-Cordon-Approval-Id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        message, re.IGNORECASE,
    )
    return match.group(1) if match else None


def _parse_retry_after(message: str) -> int:
    match = re.search(r"Retry after (\d+)s", message)
    return int(match.group(1)) if match else 0
