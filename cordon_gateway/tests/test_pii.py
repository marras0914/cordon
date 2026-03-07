"""
PII redaction unit tests.
"""
import pytest
import pii


class TestRedactStrings:
    def test_email(self):
        assert pii.redact("contact john.doe@example.com now") == \
               "contact [REDACTED:EMAIL] now"

    def test_ssn(self):
        assert pii.redact("SSN: 123-45-6789") == "SSN: [REDACTED:SSN]"

    def test_phone_us(self):
        assert pii.redact("call 555-867-5309") == "call [REDACTED:PHONE]"

    def test_phone_with_country_code(self):
        assert pii.redact("+1 800-555-1234") == "[REDACTED:PHONE]"

    def test_credit_card(self):
        assert pii.redact("card 4111 1111 1111 1111 done") == \
               "card [REDACTED:CREDIT_CARD] done"

    def test_ipv4(self):
        assert pii.redact("host 192.168.1.100") == "host [REDACTED:IPV4]"

    def test_no_pii_unchanged(self):
        assert pii.redact("ls -la /var/log") == "ls -la /var/log"

    def test_multiple_pii_types(self):
        result = pii.redact("email: foo@bar.com ssn: 111-22-3333")
        assert "[REDACTED:EMAIL]" in result
        assert "[REDACTED:SSN]" in result
        assert "foo@bar.com" not in result
        assert "111-22-3333" not in result


class TestRedactStructures:
    def test_dict(self):
        result = pii.redact({"user": "admin@corp.com", "cmd": "ls"})
        assert result["user"] == "[REDACTED:EMAIL]"
        assert result["cmd"] == "ls"

    def test_nested_dict(self):
        result = pii.redact({"outer": {"inner": "999-99-9999"}})
        assert result["outer"]["inner"] == "[REDACTED:SSN]"

    def test_list(self):
        result = pii.redact(["safe", "bad@email.com"])
        assert result[0] == "safe"
        assert result[1] == "[REDACTED:EMAIL]"

    def test_non_string_values_pass_through(self):
        result = pii.redact({"count": 42, "flag": True, "nothing": None})
        assert result == {"count": 42, "flag": True, "nothing": None}

    def test_empty_dict(self):
        assert pii.redact({}) == {}

    def test_empty_string(self):
        assert pii.redact("") == ""


class TestDisabled:
    def test_disabled_skips_redaction(self, monkeypatch):
        monkeypatch.setattr(pii, "ENABLED", False)
        assert pii.redact("foo@bar.com") == "foo@bar.com"

    def test_enabled_redacts(self, monkeypatch):
        monkeypatch.setattr(pii, "ENABLED", True)
        assert pii.redact("foo@bar.com") == "[REDACTED:EMAIL]"


class TestPiiInGateway:
    """PII redaction is applied before arguments are stored."""

    def test_pii_in_arguments_is_redacted_in_queue(self, client):
        import db
        payload = {
            "jsonrpc": "2.0", "id": 1,
            "method": "tools/call",
            "params": {"name": "execute_shell",
                       "arguments": {"cmd": "echo admin@corp.com"}},
        }
        client.post("/messages", json=payload)
        pending = db.get_pending_approvals()
        assert len(pending) == 1
        assert "admin@corp.com" not in pending[0]["arguments"]
        assert "[REDACTED:EMAIL]" in pending[0]["arguments"]

    def test_clean_arguments_stored_unchanged(self, client):
        import db
        payload = {
            "jsonrpc": "2.0", "id": 2,
            "method": "tools/call",
            "params": {"name": "execute_shell",
                       "arguments": {"cmd": "ls -la /var/log"}},
        }
        client.post("/messages", json=payload)
        pending = db.get_pending_approvals()
        assert "ls -la /var/log" in pending[0]["arguments"]
