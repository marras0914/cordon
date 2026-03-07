"""
Per-client sliding-window rate limiter.

Controlled by env vars:
  CORDON_RATE_LIMIT      — max tool calls per window (int, 0 = disabled, default 60)
  CORDON_RATE_WINDOW     — window size in seconds (int, default 60)
"""
import os
import time
import threading
from collections import deque

RATE_LIMIT  = int(os.getenv("CORDON_RATE_LIMIT",  "60"))   # 0 = disabled
RATE_WINDOW = int(os.getenv("CORDON_RATE_WINDOW", "60"))    # seconds

# {client_ip: deque of timestamps}
_buckets: dict[str, deque] = {}
_lock = threading.Lock()


def check(client_ip: str) -> tuple[bool, int]:
    """
    Record a call attempt and check whether it is within the rate limit.

    Returns:
        (allowed, retry_after_seconds)
        retry_after is 0 when allowed, estimated seconds when denied.
    """
    if not RATE_LIMIT:
        return True, 0

    now = time.monotonic()
    cutoff = now - RATE_WINDOW

    with _lock:
        if client_ip not in _buckets:
            _buckets[client_ip] = deque()

        bucket = _buckets[client_ip]

        # Evict timestamps outside the window
        while bucket and bucket[0] <= cutoff:
            bucket.popleft()

        if len(bucket) >= RATE_LIMIT:
            # Oldest call in window — window resets this many seconds from now
            retry_after = int(RATE_WINDOW - (now - bucket[0])) + 1
            return False, retry_after

        bucket.append(now)
        return True, 0


def reset(client_ip: str | None = None) -> None:
    """Clear rate-limit state. Pass None to reset all clients (used in tests)."""
    with _lock:
        if client_ip is None:
            _buckets.clear()
        else:
            _buckets.pop(client_ip, None)
