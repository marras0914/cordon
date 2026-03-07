"""
Cordon SDK — Python client for the Cordon MCP Security Gateway.

    pip install cordon-sdk

Usage:
    import asyncio
    from cordon_sdk import CordonClient, PolicyBlocked, ApprovalTimeout

    async def main():
        async with CordonClient("http://localhost:8000") as cordon:
            result = await cordon.call_tool("read_file", {"path": "/etc/hosts"})
            print(result)

    asyncio.run(main())
"""

from .client import (
    CordonClient,
    CordonError,
    PolicyBlocked,
    ApprovalRejected,
    ApprovalTimeout,
    RateLimited,
)

__all__ = [
    "CordonClient",
    "CordonError",
    "PolicyBlocked",
    "ApprovalRejected",
    "ApprovalTimeout",
    "RateLimited",
]

__version__ = "0.1.0"
