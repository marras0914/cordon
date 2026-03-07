"""
PII redaction for Cordon audit logs and approval queue.

Scans string values recursively and replaces matched patterns with
[REDACTED:<TYPE>] tokens. Applied before anything is written to the DB
so PII never lands on disk.

Controlled by the CORDON_REDACT_PII env var (default: true).
Set to "false" to disable (not recommended outside dev).
"""
import os
import re
from typing import Any

ENABLED = os.getenv("CORDON_REDACT_PII", "true").lower() not in ("false", "0", "no")

# Order matters: more-specific patterns first
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("CREDIT_CARD", re.compile(r"\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b")),
    ("SSN",         re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("EMAIL",       re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")),
    ("PHONE",       re.compile(
        r"(?<!\d)(\+1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}(?!\d)"
    )),
    ("IPV4",        re.compile(
        r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b"
    )),
]


def redact(value: Any) -> Any:
    """Recursively redact PII from strings, dicts, and lists."""
    if not ENABLED:
        return value
    if isinstance(value, str):
        for label, pattern in _PATTERNS:
            value = pattern.sub(f"[REDACTED:{label}]", value)
        return value
    if isinstance(value, dict):
        return {k: redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def redact_str(value: str) -> str:
    """Convenience wrapper that always returns a string."""
    result = redact(value)
    return result if isinstance(result, str) else str(result)
