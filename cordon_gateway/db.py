"""
Database layer for Cordon.

Supports two backends, selected by environment variable:
  - SQLite  (default)  — zero-config, good for single-node / dev
  - Postgres           — set DATABASE_URL=postgresql://user:pass@host/dbname

The public API (init_db, log_event, get_logs, …) is identical for both backends.
psycopg2 is imported lazily — it's only required when DATABASE_URL is set.
"""

import os
import sqlite3
from datetime import datetime, timezone

# ---------- config ----------

DATABASE_URL = os.getenv("DATABASE_URL", "")          # empty → SQLite
DB_PATH      = os.getenv("CORDON_DB", "cordon_audit.db")  # SQLite file path
PH           = "%s" if DATABASE_URL else "?"          # SQL placeholder token

# ---------- connection ----------

def _connect():
    if DATABASE_URL:
        try:
            import psycopg2
        except ImportError:
            raise RuntimeError(
                "DATABASE_URL is set but psycopg2 is not installed. "
                "Run: pip install psycopg2-binary"
            )
        return psycopg2.connect(DATABASE_URL)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def _rows(cursor) -> list[dict]:
    """Normalise rows from either backend into plain dicts."""
    if DATABASE_URL:
        cols = [d[0] for d in cursor.description]
        return [dict(zip(cols, row)) for row in cursor.fetchall()]
    return [dict(r) for r in cursor.fetchall()]


def _row(cursor) -> dict | None:
    if DATABASE_URL:
        cols = [d[0] for d in cursor.description]
        row  = cursor.fetchone()
        return dict(zip(cols, row)) if row else None
    row = cursor.fetchone()
    return dict(row) if row else None

# ---------- schema ----------

_AUDIT_SCHEMA_SQLITE = """
    CREATE TABLE IF NOT EXISTS audit_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   TEXT    NOT NULL,
        tool_name   TEXT,
        method      TEXT    NOT NULL,
        action      TEXT    NOT NULL,
        reason      TEXT,
        request_id  TEXT,
        client_ip   TEXT,
        user_email  TEXT
    )"""

_AUDIT_SCHEMA_PG = """
    CREATE TABLE IF NOT EXISTS audit_log (
        id          BIGSERIAL PRIMARY KEY,
        timestamp   TEXT      NOT NULL,
        tool_name   TEXT,
        method      TEXT      NOT NULL,
        action      TEXT      NOT NULL,
        reason      TEXT,
        request_id  TEXT,
        client_ip   TEXT,
        user_email  TEXT
    )"""

_QUEUE_SCHEMA_SQLITE = """
    CREATE TABLE IF NOT EXISTS approval_queue (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        arguments   TEXT,
        request_id  TEXT,
        client_ip   TEXT,
        status      TEXT NOT NULL DEFAULT 'PENDING',
        resolved_at TEXT,
        resolved_by TEXT
    )"""

_QUEUE_SCHEMA_PG = """
    CREATE TABLE IF NOT EXISTS approval_queue (
        id          TEXT PRIMARY KEY,
        timestamp   TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        arguments   TEXT,
        request_id  TEXT,
        client_ip   TEXT,
        status      TEXT NOT NULL DEFAULT 'PENDING',
        resolved_at TEXT,
        resolved_by TEXT
    )"""


def init_db():
    con = _connect()
    cur = con.cursor()
    cur.execute(_AUDIT_SCHEMA_PG if DATABASE_URL else _AUDIT_SCHEMA_SQLITE)
    cur.execute(_QUEUE_SCHEMA_PG if DATABASE_URL else _QUEUE_SCHEMA_SQLITE)

    # Safe migration for existing DBs that predate user_email / resolved_by
    if DATABASE_URL:
        migrations = [
            "ALTER TABLE audit_log     ADD COLUMN IF NOT EXISTS user_email  TEXT",
            "ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS resolved_by TEXT",
        ]
        for sql in migrations:
            cur.execute(sql)
    else:
        for sql in (
            "ALTER TABLE audit_log     ADD COLUMN user_email  TEXT",
            "ALTER TABLE approval_queue ADD COLUMN resolved_by TEXT",
        ):
            try:
                cur.execute(sql)
            except sqlite3.OperationalError:
                pass  # column already exists

    con.commit()
    con.close()


# ---------- audit log ----------

def log_event(*, method: str, action: str, tool_name: str = None,
              reason: str = "", request_id=None, client_ip: str = None,
              user_email: str = None):
    con = _connect()
    cur = con.cursor()
    cur.execute(
        f"""INSERT INTO audit_log
               (timestamp, tool_name, method, action, reason, request_id, client_ip, user_email)
           VALUES ({PH},{PH},{PH},{PH},{PH},{PH},{PH},{PH})""",
        (
            datetime.now(timezone.utc).isoformat(),
            tool_name, method, action, reason,
            str(request_id) if request_id is not None else None,
            client_ip, user_email,
        ),
    )
    con.commit()
    con.close()


def get_logs(limit: int = 100, offset: int = 0) -> list[dict]:
    con = _connect()
    cur = con.cursor()
    cur.execute(
        f"SELECT * FROM audit_log ORDER BY id DESC LIMIT {PH} OFFSET {PH}",
        (limit, offset),
    )
    rows = _rows(cur)
    con.close()
    return rows


def get_logs_filtered(start: str = None, end: str = None,
                      limit: int = 10_000) -> list[dict]:
    """
    Return audit log rows optionally filtered by date range.
    start / end: 'YYYY-MM-DD' strings (compared against stored ISO-8601 timestamps).
    """
    clauses, params = [], []
    if start:
        clauses.append(f"timestamp >= {PH}")
        params.append(start)
    if end:
        # end date is inclusive: add one day so "end" captures the whole day
        from datetime import date, timedelta
        end_dt = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
        clauses.append(f"timestamp < {PH}")
        params.append(end_dt)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    con = _connect()
    cur = con.cursor()
    cur.execute(
        f"SELECT * FROM audit_log {where} ORDER BY timestamp ASC LIMIT {PH}",
        params,
    )
    rows = _rows(cur)
    con.close()
    return rows


def get_log_count() -> int:
    con = _connect()
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM audit_log")
    count = cur.fetchone()[0]
    con.close()
    return count


# ---------- approval queue ----------

def queue_approval(approval_id: str, tool_name: str, arguments: str,
                   request_id=None, client_ip: str = None):
    con = _connect()
    cur = con.cursor()
    cur.execute(
        f"""INSERT INTO approval_queue
               (id, timestamp, tool_name, arguments, request_id, client_ip, status)
           VALUES ({PH},{PH},{PH},{PH},{PH},{PH},'PENDING')""",
        (
            approval_id,
            datetime.now(timezone.utc).isoformat(),
            tool_name, arguments,
            str(request_id) if request_id is not None else None,
            client_ip,
        ),
    )
    con.commit()
    con.close()


def get_approval(approval_id: str) -> dict | None:
    con = _connect()
    cur = con.cursor()
    cur.execute(
        f"SELECT * FROM approval_queue WHERE id = {PH}", (approval_id,)
    )
    row = _row(cur)
    con.close()
    return row


def resolve_approval(approval_id: str, status: str, resolved_by: str = None):
    con = _connect()
    cur = con.cursor()
    cur.execute(
        f"UPDATE approval_queue SET status={PH}, resolved_at={PH}, resolved_by={PH} WHERE id={PH}",
        (status, datetime.now(timezone.utc).isoformat(), resolved_by, approval_id),
    )
    con.commit()
    con.close()


def get_pending_approvals() -> list[dict]:
    con = _connect()
    cur = con.cursor()
    cur.execute(
        "SELECT * FROM approval_queue WHERE status='PENDING' ORDER BY timestamp ASC"
    )
    rows = _rows(cur)
    con.close()
    return rows


def pending_approval_count() -> int:
    con = _connect()
    cur = con.cursor()
    cur.execute("SELECT COUNT(*) FROM approval_queue WHERE status='PENDING'")
    count = cur.fetchone()[0]
    con.close()
    return count


def get_all_approvals(limit: int = 50) -> list[dict]:
    con = _connect()
    cur = con.cursor()
    cur.execute(
        f"SELECT * FROM approval_queue ORDER BY timestamp DESC LIMIT {PH}", (limit,)
    )
    rows = _rows(cur)
    con.close()
    return rows
