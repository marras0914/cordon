# cordon-sdk

Python client for the [Cordon MCP Security Gateway](https://github.com/YOUR_ORG/cordon).

Cordon is a Policy-as-Code reverse proxy that sits between AI agents and MCP servers, enforcing tool-level access control, human approval workflows, PII redaction, and audit logging.

## Install

```bash
pip install cordon-sdk
```

## Quick start

```python
import asyncio
from cordon_sdk import CordonClient, PolicyBlocked, ApprovalTimeout

async def main():
    async with CordonClient("http://localhost:8000") as cordon:
        try:
            result = await cordon.call_tool(
                "read_file",
                {"path": "/var/log/app.log"},
                approval_timeout=300,
            )
            print(result)
        except PolicyBlocked as e:
            print(f"Blocked by policy: {e.reason}")
        except ApprovalTimeout:
            print("No operator response within 5 minutes.")

asyncio.run(main())
```

## What it handles for you

- **ALLOW** — returns the tool result directly
- **BLOCK** — raises `PolicyBlocked`
- **REQUIRE_APPROVAL** — polls automatically until approved, rejected, or timed out
- **Rate limited** — raises `RateLimited` with a `retry_after` hint

## Exceptions

| Exception | Attributes |
|---|---|
| `PolicyBlocked` | `tool_name`, `reason` |
| `ApprovalRejected` | `tool_name` |
| `ApprovalTimeout` | `tool_name`, `approval_id`, `timeout` |
| `RateLimited` | `retry_after` (seconds) |
| `CordonError` | base class |

## Requirements

- Python 3.11+
- `httpx`
