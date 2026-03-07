# NERC CIP Compliance Export

Cordon's audit log is structured for NERC CIP-007-6 R6 (Security Event Monitoring) and CIP-005-7 R2 (Interactive Remote Access) compliance reporting.

---

## Accessing the export

Navigate to `/dashboard/export` in the dashboard.

Or call the API directly:

```bash
# CSV (default)
curl "http://localhost:8000/dashboard/export/audit?format=csv&start=2025-01-01&end=2025-01-31" \
  -o cordon_audit_jan2025.csv

# JSON
curl "http://localhost:8000/dashboard/export/audit?format=json&start=2025-01-01&end=2025-01-31" \
  -o cordon_audit_jan2025.json
```

---

## Query parameters

| Parameter | Description |
|---|---|
| `format` | `csv` (default) or `json` |
| `start` | Start date inclusive, `YYYY-MM-DD` |
| `end` | End date inclusive, `YYYY-MM-DD` |

Both dates are optional. Omitting them exports all records.

---

## CSV format

```
# NERC CIP-007-6 R6 / CIP-005-7 R2 Audit Export
# System: Cordon MCP Security Gateway
# Generated: 2025-01-31T23:59:59Z
# Period: 2025-01-01 to 2025-01-31
# Record count: 1247
id,timestamp,tool_name,method,action,reason,request_id,client_ip,user_email
1,2025-01-01T08:12:34.123456+00:00,read_file,tools/call,ALLOW,,req-abc,10.0.0.5,analyst@utility.com
2,2025-01-01T08:13:01.234567+00:00,delete_file,tools/call,BLOCK,Destructive file operations are restricted.,req-def,10.0.0.5,analyst@utility.com
```

---

## JSON format

```json
{
  "meta": {
    "standard":     "NERC CIP-007-6 R6 / CIP-005-7 R2",
    "system":       "Cordon MCP Security Gateway",
    "generated":    "2025-01-31T23:59:59Z",
    "period":       "2025-01-01 to 2025-01-31",
    "record_count": 1247
  },
  "records": [
    {
      "id":         1,
      "timestamp":  "2025-01-01T08:12:34.123456+00:00",
      "tool_name":  "read_file",
      "method":     "tools/call",
      "action":     "ALLOW",
      "reason":     "",
      "request_id": "req-abc",
      "client_ip":  "10.0.0.5",
      "user_email": "analyst@utility.com"
    }
  ]
}
```

---

## Fields

| Field | NERC CIP relevance |
|---|---|
| `timestamp` | Event time — required for CIP-007-6 R6 |
| `tool_name` | Resource accessed — required for R6 |
| `action` | ALLOW / BLOCK / REQUIRE_APPROVAL — security event outcome |
| `reason` | Policy rule reason — documents control basis |
| `client_ip` | Source of access — required for CIP-005-7 R2 |
| `user_email` | User identity (OIDC) — required for R2 |
| `request_id` | Correlation ID for cross-system tracing |

---

## Retention

Cordon does not enforce automatic log retention. For NERC CIP compliance, audit logs must be retained for 90 days (CIP-007-6 R6.5). Configure your database or backup process accordingly:

**SQLite** — back up `cordon_audit.db` on a schedule; prune old rows with:
```sql
DELETE FROM audit_log WHERE timestamp < date('now', '-90 days');
```

**Postgres** — use a scheduled job, pg_partman, or TimescaleDB retention policy.

---

## Automation

Schedule a monthly export with cron:

```bash
#!/bin/bash
YEAR=$(date +%Y)
MONTH=$(date +%m)
START="${YEAR}-${MONTH}-01"
END=$(date -d "${START} +1 month -1 day" +%Y-%m-%d)

curl -s "http://cordon:8000/dashboard/export/audit?format=csv&start=${START}&end=${END}" \
  -o "/audit-exports/cordon_${YEAR}_${MONTH}.csv"
```
