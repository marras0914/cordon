"""
Tests for NERC CIP compliance export endpoint.
Covers: CSV format, JSON format, date filtering, download headers, empty result set.
"""
import csv
import io
import json
from datetime import date, timedelta

import pytest


@pytest.fixture()
def dash(client):
    """Return a sub-client that prefixes /dashboard."""
    return client


def _seed(count=3, tool="read_file", action="ALLOW"):
    import db
    for i in range(count):
        db.log_event(
            method="tools/call",
            action=action,
            tool_name=tool,
            reason="test",
            request_id=f"req-{i}",
            client_ip="127.0.0.1",
            user_email=f"user{i}@example.com",
        )


# ── CSV export ────────────────────────────────────────────────────────────────

class TestCsvExport:
    def test_returns_200(self, client):
        _seed(2)
        r = client.get("/dashboard/export/audit?format=csv")
        assert r.status_code == 200

    def test_content_type_is_text_csv(self, client):
        r = client.get("/dashboard/export/audit?format=csv")
        assert "text/csv" in r.headers["content-type"]

    def test_content_disposition_attachment(self, client):
        r = client.get("/dashboard/export/audit?format=csv")
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd
        assert ".csv" in cd

    def test_nerc_comment_header_present(self, client):
        _seed(1)
        r = client.get("/dashboard/export/audit?format=csv")
        text = r.text
        assert "NERC CIP-007-6" in text
        assert "Cordon MCP Security Gateway" in text

    def test_csv_has_correct_columns(self, client):
        _seed(1)
        r = client.get("/dashboard/export/audit?format=csv")
        # Strip comment lines (start with #) to get parseable CSV
        lines = [l for l in r.text.splitlines() if not l.startswith("#")]
        reader = csv.DictReader(lines)
        expected = {"id", "timestamp", "tool_name", "method", "action",
                    "reason", "request_id", "client_ip", "user_email"}
        assert set(reader.fieldnames) == expected

    def test_csv_row_count_matches_seeded(self, client):
        _seed(5)
        r = client.get("/dashboard/export/audit?format=csv")
        lines = [l for l in r.text.splitlines() if not l.startswith("#") and l.strip()]
        # header + 5 data rows
        reader = list(csv.DictReader(lines))
        assert len(reader) == 5

    def test_csv_empty_when_no_logs(self, client):
        r = client.get("/dashboard/export/audit?format=csv")
        lines = [l for l in r.text.splitlines() if not l.startswith("#") and l.strip()]
        reader = list(csv.DictReader(lines))
        assert len(reader) == 0

    def test_default_format_is_csv(self, client):
        r = client.get("/dashboard/export/audit")
        assert "text/csv" in r.headers["content-type"]


# ── JSON export ───────────────────────────────────────────────────────────────

class TestJsonExport:
    def test_returns_200(self, client):
        r = client.get("/dashboard/export/audit?format=json")
        assert r.status_code == 200

    def test_content_type_is_json(self, client):
        r = client.get("/dashboard/export/audit?format=json")
        assert "application/json" in r.headers["content-type"]

    def test_content_disposition_attachment(self, client):
        r = client.get("/dashboard/export/audit?format=json")
        cd = r.headers.get("content-disposition", "")
        assert "attachment" in cd
        assert ".json" in cd

    def test_meta_block_present(self, client):
        r = client.get("/dashboard/export/audit?format=json")
        payload = r.json()
        assert "meta" in payload
        meta = payload["meta"]
        assert "NERC CIP-007-6" in meta["standard"]
        assert "Cordon MCP Security Gateway" in meta["system"]
        assert "generated" in meta
        assert "period" in meta
        assert "record_count" in meta

    def test_records_key_present(self, client):
        _seed(3)
        r = client.get("/dashboard/export/audit?format=json")
        payload = r.json()
        assert "records" in payload
        assert len(payload["records"]) == 3

    def test_record_count_in_meta_matches(self, client):
        _seed(4)
        r = client.get("/dashboard/export/audit?format=json")
        payload = r.json()
        assert payload["meta"]["record_count"] == 4
        assert len(payload["records"]) == 4

    def test_invalid_format_rejected(self, client):
        r = client.get("/dashboard/export/audit?format=xml")
        assert r.status_code == 422


# ── Date filtering ────────────────────────────────────────────────────────────

class TestDateFiltering:
    def test_start_date_filters_out_older_records(self, client):
        import db, sqlite3, os
        # Insert a row with a past timestamp by manipulating directly
        db.log_event(method="tools/call", action="ALLOW", tool_name="old_tool",
                     reason="old", request_id="old-1")
        # Patch the timestamp to be 10 days ago
        past = (date.today() - timedelta(days=10)).isoformat()
        con = sqlite3.connect(db.DB_PATH)
        con.execute("UPDATE audit_log SET timestamp = ? WHERE request_id = 'old-1'", (past + "T00:00:00",))
        con.commit()
        con.close()

        # Insert a recent record
        db.log_event(method="tools/call", action="ALLOW", tool_name="new_tool",
                     reason="new", request_id="new-1")

        today = date.today().isoformat()
        r = client.get(f"/dashboard/export/audit?format=json&start={today}")
        payload = r.json()
        tool_names = [rec["tool_name"] for rec in payload["records"]]
        assert "new_tool" in tool_names
        assert "old_tool" not in tool_names

    def test_end_date_filters_out_future_records(self, client):
        import db, sqlite3
        db.log_event(method="tools/call", action="ALLOW", tool_name="old_tool",
                     request_id="old-2")
        # Patch to yesterday
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        con = sqlite3.connect(db.DB_PATH)
        con.execute("UPDATE audit_log SET timestamp = ? WHERE request_id = 'old-2'",
                    (yesterday + "T00:00:00",))
        con.commit()
        con.close()

        # Also a today record
        db.log_event(method="tools/call", action="ALLOW", tool_name="today_tool",
                     request_id="today-2")

        r = client.get(f"/dashboard/export/audit?format=json&end={yesterday}")
        payload = r.json()
        tool_names = [rec["tool_name"] for rec in payload["records"]]
        assert "old_tool" in tool_names
        assert "today_tool" not in tool_names

    def test_period_reflected_in_meta(self, client):
        r = client.get("/dashboard/export/audit?format=json&start=2025-01-01&end=2025-01-31")
        meta = r.json()["meta"]
        assert "2025-01-01" in meta["period"]
        assert "2025-01-31" in meta["period"]

    def test_no_dates_uses_beginning_and_present(self, client):
        r = client.get("/dashboard/export/audit?format=json")
        meta = r.json()["meta"]
        assert "beginning" in meta["period"]
        assert "present" in meta["period"]


# ── Export page ───────────────────────────────────────────────────────────────

class TestExportPage:
    def test_export_page_loads(self, client):
        r = client.get("/dashboard/export")
        assert r.status_code == 200
        assert "Export" in r.text

    def test_export_page_has_form(self, client):
        r = client.get("/dashboard/export")
        assert 'action="/dashboard/export/audit"' in r.text
