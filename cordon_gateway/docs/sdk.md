# Cordon SDK

The Cordon SDK is a thin async Python client that wraps the gateway's HTTP API. Its main job is managing the HITL approval retry loop so you don't have to.

---

## Installation

Copy `cordon_sdk.py` into your project, or install from the repo:

```bash
pip install httpx   # only external dependency
```

---

## Basic usage

```python
import asyncio
from cordon_sdk import CordonClient, PolicyBlocked, ApprovalTimeout

async def main():
    async with CordonClient("http://localhost:8000") as cordon:
        result = await cordon.call_tool(
            "read_file",
            {"path": "/var/log/app.log"},
        )
        print(result)

asyncio.run(main())
```

---

## `CordonClient`

```python
CordonClient(
    base_url: str,
    poll_interval: float = 5.0,   # seconds between approval polls
    http_timeout: float = 10.0,   # httpx request timeout
)
```

Use as an async context manager (`async with`) or call `await client.aclose()` manually.

---

## `call_tool`

```python
result = await cordon.call_tool(
    tool_name: str,
    arguments: dict,
    approval_timeout: int = 300,   # max seconds to wait for human approval
    request_id: int | str | None = None,
)
```

**Returns** the tool result dict on success.

**Raises:**

| Exception | When |
|---|---|
| `PolicyBlocked(tool_name, reason)` | Tool was blocked by policy (`-32001`) |
| `ApprovalRejected(tool_name)` | Operator rejected the request |
| `ApprovalTimeout(tool_name, approval_id, timeout)` | `approval_timeout` elapsed |
| `RateLimited(retry_after)` | Gateway rate limit exceeded (`-32005`) |
| `CordonError` | Any other gateway error |

---

## Approval flow (automatic)

When a tool requires human approval, `call_tool` handles the whole loop:

1. First POST returns `-32002` with a UUID
2. SDK extracts the UUID and waits `poll_interval` seconds
3. Retries with `X-Cordon-Approval-Id: <uuid>` header
4. Repeats until approved, rejected, or `approval_timeout` reached

```python
# The agent code looks the same whether or not approval is needed
try:
    result = await cordon.call_tool(
        "execute_shell",
        {"cmd": "systemctl restart nginx"},
        approval_timeout=600,   # wait up to 10 minutes
    )
except ApprovalTimeout:
    print("Timed out — operator did not respond.")
except ApprovalRejected:
    print("Operator said no.")
```

---

## Rate limiting

```python
from cordon_sdk import RateLimited

try:
    result = await cordon.call_tool("read_file", {"path": "/data"})
except RateLimited as e:
    print(f"Slow down. Retry in {e.retry_after}s.")
    await asyncio.sleep(e.retry_after)
```

---

## Non-context-manager usage

```python
cordon = CordonClient("http://localhost:8000")
try:
    result = await cordon.call_tool("list_files", {"dir": "/tmp"})
finally:
    await cordon.aclose()
```

---

## Multiple tools

```python
async with CordonClient("http://localhost:8000") as cordon:
    # Sequential
    logs  = await cordon.call_tool("read_file",  {"path": "/var/log/app.log"})
    stats = await cordon.call_tool("get_metrics", {"host": "prod-01"})

    # Parallel
    import asyncio
    logs, stats = await asyncio.gather(
        cordon.call_tool("read_file",   {"path": "/var/log/app.log"}),
        cordon.call_tool("get_metrics", {"host": "prod-01"}),
    )
```
