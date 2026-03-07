"""Tests for per-client sliding-window rate limiter."""
import pytest
import ratelimit


@pytest.fixture(autouse=True)
def reset_buckets():
    ratelimit.reset()
    yield
    ratelimit.reset()


class TestRateLimitDisabled:
    def test_zero_limit_always_allows(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 0)
        for _ in range(200):
            allowed, retry = ratelimit.check("1.2.3.4")
        assert allowed is True
        assert retry == 0


class TestRateLimitEnforced:
    def test_first_call_allowed(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 5)
        allowed, retry = ratelimit.check("10.0.0.1")
        assert allowed is True
        assert retry == 0

    def test_calls_within_limit_allowed(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 5)
        for _ in range(5):
            allowed, _ = ratelimit.check("10.0.0.1")
            assert allowed is True

    def test_call_exceeding_limit_denied(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 3)
        for _ in range(3):
            ratelimit.check("10.0.0.2")
        allowed, retry = ratelimit.check("10.0.0.2")
        assert allowed is False
        assert retry > 0

    def test_retry_after_is_positive(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 2)
        ratelimit.check("10.0.0.3")
        ratelimit.check("10.0.0.3")
        allowed, retry = ratelimit.check("10.0.0.3")
        assert not allowed
        assert isinstance(retry, int)
        assert retry >= 1

    def test_different_ips_tracked_independently(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 2)
        ratelimit.check("1.1.1.1")
        ratelimit.check("1.1.1.1")
        ratelimit.check("1.1.1.1")  # over limit for 1.1.1.1

        allowed, _ = ratelimit.check("2.2.2.2")  # fresh IP
        assert allowed is True

    def test_denied_call_does_not_consume_slot(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 2)
        ratelimit.check("10.0.0.4")
        ratelimit.check("10.0.0.4")
        # Denied — bucket stays at 2
        ratelimit.check("10.0.0.4")
        ratelimit.check("10.0.0.4")
        # Still denied, not at 4
        allowed, _ = ratelimit.check("10.0.0.4")
        assert allowed is False


class TestRateLimitReset:
    def test_reset_single_ip(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 2)
        ratelimit.check("5.5.5.5")
        ratelimit.check("5.5.5.5")
        ratelimit.check("5.5.5.5")  # over
        ratelimit.reset("5.5.5.5")
        allowed, _ = ratelimit.check("5.5.5.5")
        assert allowed is True

    def test_reset_all(self, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 1)
        ratelimit.check("6.6.6.6")
        ratelimit.check("7.7.7.7")
        ratelimit.reset()
        for ip in ("6.6.6.6", "7.7.7.7"):
            allowed, _ = ratelimit.check(ip)
            assert allowed is True


class TestRateLimitGatewayIntegration:
    def test_rate_limited_returns_32005(self, client, monkeypatch):
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 2)
        ratelimit.reset()
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": "read_file", "arguments": {}}}
        # Fill up the bucket
        client.post("/messages", json=payload)
        client.post("/messages", json=payload)
        # Third call should be rate-limited
        r = client.post("/messages", json=payload)
        body = r.json()
        assert body["error"]["code"] == -32005
        assert "rate limit" in body["error"]["message"].lower()

    def test_rate_limited_logged_as_block(self, client, monkeypatch):
        import db
        monkeypatch.setattr(ratelimit, "RATE_LIMIT", 1)
        ratelimit.reset()
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                   "params": {"name": "rate_test_tool", "arguments": {}}}
        client.post("/messages", json=payload)  # allowed
        client.post("/messages", json=payload)  # rate limited
        logs = db.get_logs(limit=10)
        rate_blocks = [l for l in logs if l["reason"] == "Rate limit exceeded"]
        assert len(rate_blocks) >= 1
