"""Tests for webhook alerting module."""
import asyncio
from unittest.mock import AsyncMock, patch, MagicMock
import pytest
import alerting


@pytest.fixture(autouse=True)
def set_webhook(monkeypatch):
    monkeypatch.setattr(alerting, "WEBHOOK_URL", "http://fake-webhook/hook")
    monkeypatch.setattr(alerting, "ALERT_ON_BLOCK", True)
    monkeypatch.setattr(alerting, "QUEUE_THRESHOLD", 3)


# ── on_block ─────────────────────────────────────────────────────────────────

class TestOnBlock:
    def test_fires_when_enabled(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_block("delete_file", "Destructive", "1.2.3.4")
        assert len(fired) == 1

    def test_payload_is_slack_compatible(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_block("delete_file", "Destructive", "1.2.3.4")
        assert "text" in fired[0]

    def test_payload_contains_tool_name(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_block("execute_shell", "Restricted", None)
        assert "execute_shell" in fired[0]["text"]

    def test_payload_contains_reason(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_block("delete_file", "My reason here", None)
        assert "My reason here" in fired[0]["text"]

    def test_payload_contains_client_ip_when_given(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_block("delete_file", "reason", "10.0.0.1")
        assert "10.0.0.1" in fired[0]["text"]

    def test_no_fire_when_alert_on_block_disabled(self, monkeypatch):
        monkeypatch.setattr(alerting, "ALERT_ON_BLOCK", False)
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_block("delete_file", "reason", None)
        assert fired == []

    def test_no_fire_when_no_webhook_url(self, monkeypatch):
        monkeypatch.setattr(alerting, "WEBHOOK_URL", "")
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_block("delete_file", "reason", None)
        assert fired == []


# ── on_approval_queued ────────────────────────────────────────────────────────

class TestOnApprovalQueued:
    def test_fires_when_count_meets_threshold(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_approval_queued("execute_shell", 3)
        assert len(fired) == 1

    def test_fires_when_count_exceeds_threshold(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_approval_queued("execute_shell", 10)
        assert len(fired) == 1

    def test_no_fire_when_count_below_threshold(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_approval_queued("execute_shell", 2)
        assert fired == []

    def test_payload_contains_tool_name(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_approval_queued("restart_service", 5)
        assert "restart_service" in fired[0]["text"]

    def test_payload_contains_count(self, monkeypatch):
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_approval_queued("restart_service", 7)
        assert "7" in fired[0]["text"]

    def test_no_fire_when_threshold_is_zero(self, monkeypatch):
        monkeypatch.setattr(alerting, "QUEUE_THRESHOLD", 0)
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_approval_queued("execute_shell", 999)
        assert fired == []

    def test_no_fire_when_no_webhook_url(self, monkeypatch):
        monkeypatch.setattr(alerting, "WEBHOOK_URL", "")
        fired = []
        monkeypatch.setattr(alerting, "_fire", lambda p: fired.append(p))
        alerting.on_approval_queued("execute_shell", 100)
        assert fired == []


# ── _post (HTTP layer) ────────────────────────────────────────────────────────

class TestPost:
    def test_posts_to_webhook_url(self):
        async def run():
            with patch("httpx.AsyncClient") as mock_cls:
                mock_client = AsyncMock()
                mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
                mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
                await alerting._post({"text": "hello"})
                mock_client.post.assert_called_once()
                url = mock_client.post.call_args[0][0]
                assert url == "http://fake-webhook/hook"

        asyncio.run(run())

    def test_swallows_http_errors(self):
        async def run():
            with patch("httpx.AsyncClient") as mock_cls:
                mock_client = AsyncMock()
                mock_client.post.side_effect = Exception("network down")
                mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
                mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
                # Should not raise
                await alerting._post({"text": "hello"})

        asyncio.run(run())

    def test_no_post_when_no_webhook_url(self, monkeypatch):
        monkeypatch.setattr(alerting, "WEBHOOK_URL", "")

        async def run():
            with patch("httpx.AsyncClient") as mock_cls:
                await alerting._post({"text": "hello"})
                mock_cls.assert_not_called()

        asyncio.run(run())
