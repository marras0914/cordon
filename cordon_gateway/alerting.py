"""
Webhook alerting for Cordon events.

Sends JSON payloads compatible with Slack and Microsoft Teams incoming webhooks.

Env vars:
  CORDON_WEBHOOK_URL          — destination URL (empty = alerting disabled)
  CORDON_ALERT_ON_BLOCK       — fire on every BLOCK decision (default "true")
  CORDON_ALERT_QUEUE_THRESHOLD — fire when pending approvals reach this count (default 5, 0 = disabled)
"""
import os
import asyncio
import httpx

WEBHOOK_URL       = os.getenv("CORDON_WEBHOOK_URL", "")
ALERT_ON_BLOCK    = os.getenv("CORDON_ALERT_ON_BLOCK", "true").lower() == "true"
QUEUE_THRESHOLD   = int(os.getenv("CORDON_ALERT_QUEUE_THRESHOLD", "5"))


def _slack_text(text: str) -> dict:
    """Slack/Teams compatible payload."""
    return {"text": text}


async def _post(payload: dict) -> None:
    """Fire-and-forget POST to the webhook URL. Swallows errors."""
    if not WEBHOOK_URL:
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(WEBHOOK_URL, json=payload)
    except Exception as exc:
        print(f"[CORDON] Alert webhook failed: {exc}")


def _fire(payload: dict) -> None:
    """Schedule the POST on the running event loop (non-blocking)."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            asyncio.ensure_future(_post(payload))
        else:
            loop.run_until_complete(_post(payload))
    except RuntimeError:
        pass  # no event loop — skip silently (e.g., test teardown)


def on_block(tool_name: str, reason: str, client_ip: str | None = None) -> None:
    """Call after every BLOCK decision (human-rejected included)."""
    if not WEBHOOK_URL or not ALERT_ON_BLOCK:
        return
    ip_str = f" from `{client_ip}`" if client_ip else ""
    text = (
        f":no_entry: *Cordon blocked tool call*\n"
        f"Tool: `{tool_name}`{ip_str}\n"
        f"Reason: {reason}"
    )
    _fire(_slack_text(text))


def on_approval_queued(tool_name: str, pending_count: int) -> None:
    """Call after a tool is queued for approval. Fires if threshold is reached."""
    if not WEBHOOK_URL or not QUEUE_THRESHOLD:
        return
    if pending_count >= QUEUE_THRESHOLD:
        text = (
            f":warning: *Cordon approval queue has {pending_count} pending requests*\n"
            f"Latest: `{tool_name}` — operator action required."
        )
        _fire(_slack_text(text))
