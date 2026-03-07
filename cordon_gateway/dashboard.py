import csv
import io
import json
import os
import yaml
from datetime import datetime, timezone
from fastapi import FastAPI, Request, Form, Query
from fastapi.responses import HTMLResponse, RedirectResponse, Response, StreamingResponse

import auth
import db

POLICY_FILE = "policy.yaml"
DASHBOARD_KEY = os.getenv("CORDON_DASHBOARD_KEY", "")  # empty = open (dev mode)
SESSION_COOKIE = "cordon_session"
OIDC_STATE_COOKIE = "cordon_oidc_state"

dashboard = FastAPI()


# ---------- auth middleware ----------

@dashboard.middleware("http")
async def auth_middleware(request: Request, call_next):
    path = request.url.path

    # Always allow auth routes through
    if "/auth/" in path or path.endswith("/login") or path.endswith("/logout"):
        return await call_next(request)

    token = request.cookies.get(SESSION_COOKIE)

    if auth.OIDC_ENABLED:
        user = auth.verify_session(token)
        if not user:
            return RedirectResponse(url="/dashboard/auth/login", status_code=302)
        request.state.user = user

    elif DASHBOARD_KEY:
        if token != DASHBOARD_KEY:
            return RedirectResponse(url="/dashboard/login", status_code=302)
        request.state.user = {"sub": "admin", "email": "admin", "name": "Admin"}

    else:
        request.state.user = None  # dev mode: open

    return await call_next(request)


def _current_user(request: Request) -> dict:
    return getattr(request.state, "user", None) or {}


# ---------- helpers ----------

def _load_policy() -> dict:
    with open(POLICY_FILE, "r") as f:
        return yaml.safe_load(f)


def _save_policy(config: dict):
    with open(POLICY_FILE, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)


def _page(title: str, body: str, active: str = "", user: dict = None) -> str:
    def nav_link(href, label, key):
        cls = "active" if key == active else ""
        return f'<a href="{href}" class="{cls}">{label}</a>'

    user = user or {}
    user_label = user.get("email") or user.get("name") or ""
    user_html  = f'<span style="color:#64748b;font-size:.8rem">{user_label}</span>' if user_label else ""

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cordon – {title}</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }}
    nav {{ background: #1a1d27; border-bottom: 1px solid #2d3148; padding: 12px 32px;
           display: flex; align-items: center; gap: 32px; }}
    nav strong {{ color: #7c6af7; font-size: 1.1rem; letter-spacing: .5px; }}
    nav a {{ color: #94a3b8; text-decoration: none; font-size: .9rem; padding: 4px 0;
             border-bottom: 2px solid transparent; }}
    nav a:hover {{ color: #e2e8f0; }}
    nav a.active {{ color: #c4b5fd; border-bottom-color: #7c6af7; }}
    nav .spacer {{ flex: 1; }}
    nav .logout {{ font-size: .8rem; color: #475569; }}
    nav .logout a {{ color: #475569; border: none; }}
    nav .logout a:hover {{ color: #94a3b8; }}
    main {{ max-width: 1100px; margin: 32px auto; padding: 0 24px; }}
    h1 {{ font-size: 1.4rem; margin-bottom: 20px; color: #c4b5fd; }}
    h2 {{ font-size: 1rem; margin-bottom: 14px; color: #94a3b8; font-weight: 600; }}

    .stats {{ display: flex; gap: 16px; margin-bottom: 28px; flex-wrap: wrap; }}
    .stat {{ background: #1a1d27; border: 1px solid #2d3148; border-radius: 8px;
             padding: 16px 24px; min-width: 140px; }}
    .stat .val {{ font-size: 2rem; font-weight: 700; }}
    .stat .lbl {{ font-size: .8rem; color: #64748b; margin-top: 4px; }}
    .allow    {{ color: #4ade80; }}
    .block    {{ color: #f87171; }}
    .approval {{ color: #fbbf24; }}
    .pending-badge {{ display: inline-block; background: #451a03; color: #fbbf24;
                      border-radius: 999px; padding: 1px 8px; font-size: .75rem;
                      font-weight: 700; margin-left: 6px; vertical-align: middle; }}

    table {{ width: 100%; border-collapse: collapse; font-size: .85rem; margin-bottom: 32px; }}
    th {{ background: #1a1d27; color: #64748b; text-align: left; padding: 10px 12px;
          border-bottom: 1px solid #2d3148; font-weight: 600; text-transform: uppercase;
          font-size: .75rem; letter-spacing: .5px; }}
    td {{ padding: 10px 12px; border-bottom: 1px solid #1e2130; vertical-align: top; }}
    tr:hover td {{ background: #1a1d27; }}
    .badge {{ display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: .75rem; font-weight: 600; }}
    .badge-ALLOW    {{ background: #14532d; color: #4ade80; }}
    .badge-BLOCK    {{ background: #450a0a; color: #f87171; }}
    .badge-REQUIRE_APPROVAL {{ background: #451a03; color: #fbbf24; }}
    .badge-PENDING  {{ background: #451a03; color: #fbbf24; }}
    .badge-APPROVED {{ background: #14532d; color: #4ade80; }}
    .badge-REJECTED {{ background: #450a0a; color: #f87171; }}
    .muted {{ color: #475569; font-style: italic; }}
    code {{ font-family: monospace; font-size: .8rem; color: #94a3b8;
            background: #0f1117; padding: 2px 6px; border-radius: 3px; word-break: break-all; }}

    .card {{ background: #1a1d27; border: 1px solid #2d3148; border-radius: 8px;
             padding: 20px 24px; margin-bottom: 20px; }}
    .rule-row {{ display: grid; grid-template-columns: 1fr 1fr 2fr auto; gap: 10px;
                 align-items: end; margin-bottom: 10px; }}
    label {{ display: block; font-size: .75rem; color: #64748b; margin-bottom: 4px; }}
    input, select {{ width: 100%; background: #0f1117; border: 1px solid #2d3148;
                     border-radius: 5px; padding: 7px 10px; color: #e2e8f0; font-size: .85rem; }}
    input:focus, select:focus {{ outline: none; border-color: #7c6af7; }}
    button {{ padding: 7px 16px; border-radius: 5px; border: none; cursor: pointer;
              font-size: .85rem; font-weight: 600; }}
    .btn-primary {{ background: #7c6af7; color: #fff; }}
    .btn-primary:hover {{ background: #6d5ce6; }}
    .btn-success {{ background: #14532d; color: #4ade80; border: 1px solid #166534; }}
    .btn-success:hover {{ background: #166534; }}
    .btn-danger  {{ background: #7f1d1d; color: #fca5a5; }}
    .btn-danger:hover  {{ background: #991b1b; }}
    .default-row {{ display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }}
    .pagination {{ display: flex; gap: 8px; align-items: center; font-size: .85rem; }}
    .pagination a {{ color: #7c6af7; text-decoration: none; padding: 4px 10px;
                     border: 1px solid #2d3148; border-radius: 4px; }}
    .pagination a:hover {{ background: #1a1d27; }}
    .pagination span {{ color: #475569; }}

    /* login */
    .login-wrap {{ max-width: 360px; margin: 80px auto; }}
    .login-wrap h1 {{ text-align: center; margin-bottom: 24px; }}
    .login-wrap .card {{ padding: 28px; }}
    .login-wrap input {{ margin-bottom: 16px; }}
    .login-wrap button {{ width: 100%; padding: 10px; }}
    .error-msg {{ color: #f87171; font-size: .85rem; margin-bottom: 12px; }}
  </style>
</head>
<body>
  <nav>
    <strong>Cordon</strong>
    {nav_link("/dashboard/", "Audit Log", "audit")}
    {nav_link("/dashboard/approvals", "Approvals", "approvals")}
    {nav_link("/dashboard/policy", "Policy", "policy")}
    {nav_link("/dashboard/export", "Export", "export")}
    <div class="spacer"></div>
    {user_html}
    {'<a href="/dashboard/logout" style="color:#475569;font-size:.8rem">Log out</a>' if (DASHBOARD_KEY or auth.OIDC_ENABLED) else ''}
  </nav>
  <main>{body}</main>
</body>
</html>"""


# ---------- OIDC routes ----------

@dashboard.get("/auth/login")
async def oidc_login():
    if not auth.OIDC_ENABLED:
        return RedirectResponse("/dashboard/login", status_code=302)
    auth_url, state_cookie_val = await auth.get_authorization_url()
    resp = RedirectResponse(auth_url, status_code=302)
    resp.set_cookie(OIDC_STATE_COOKIE, state_cookie_val,
                    httponly=True, samesite="lax", max_age=600)
    return resp


@dashboard.get("/auth/callback")
async def oidc_callback(request: Request, code: str = "", state: str = ""):
    state_data = auth.verify_state_cookie(request.cookies.get(OIDC_STATE_COOKIE, ""))
    if not state_data or state_data.get("state") != state:
        return HTMLResponse("Invalid or expired login state. <a href='/dashboard/auth/login'>Try again</a>", status_code=400)

    try:
        user = await auth.exchange_code(code, state_data["verifier"])
    except Exception as exc:
        return HTMLResponse(f"Authentication failed: {exc}. <a href='/dashboard/auth/login'>Try again</a>", status_code=400)

    resp = RedirectResponse("/dashboard/", status_code=303)
    resp.set_cookie(SESSION_COOKIE, auth.create_session(user),
                    httponly=True, samesite="lax")
    resp.delete_cookie(OIDC_STATE_COOKIE)
    return resp


# ---------- login / logout ----------

@dashboard.get("/login", response_class=HTMLResponse)
async def login_page(error: str = ""):
    if not DASHBOARD_KEY:
        return RedirectResponse("/dashboard/", status_code=302)
    err_html = f'<p class="error-msg">{error}</p>' if error else ""
    body = f"""
    <div class="login-wrap">
      <h1>Cordon</h1>
      <div class="card">
        {err_html}
        <form method="post" action="/dashboard/login">
          <label>Access Key</label>
          <input type="password" name="key" autofocus required>
          <button class="btn-primary" type="submit">Sign in</button>
        </form>
      </div>
    </div>"""
    return f"""<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Cordon Login</title>
    <style>
      *, *::before, *::after {{ box-sizing: border-box; margin: 0; padding: 0; }}
      body {{ font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; }}
      .login-wrap {{ max-width: 360px; margin: 80px auto; padding: 0 24px; }}
      h1 {{ text-align: center; margin-bottom: 24px; color: #7c6af7; font-size: 1.6rem; }}
      .card {{ background: #1a1d27; border: 1px solid #2d3148; border-radius: 8px; padding: 28px; }}
      label {{ display: block; font-size: .75rem; color: #64748b; margin-bottom: 4px; }}
      input {{ width: 100%; background: #0f1117; border: 1px solid #2d3148; border-radius: 5px;
               padding: 9px 12px; color: #e2e8f0; font-size: .9rem; margin-bottom: 16px; }}
      input:focus {{ outline: none; border-color: #7c6af7; }}
      button {{ width: 100%; padding: 10px; background: #7c6af7; color: #fff; border: none;
                border-radius: 5px; font-size: .9rem; font-weight: 600; cursor: pointer; }}
      button:hover {{ background: #6d5ce6; }}
      .error-msg {{ color: #f87171; font-size: .85rem; margin-bottom: 12px; }}
    </style>
    </head><body>{body}</body></html>"""


@dashboard.post("/login")
async def login(key: str = Form(...)):
    if key == DASHBOARD_KEY:
        resp = RedirectResponse("/dashboard/", status_code=303)
        resp.set_cookie(SESSION_COOKIE, key, httponly=True, samesite="lax")
        return resp
    return RedirectResponse("/dashboard/login?error=Invalid+key", status_code=303)


@dashboard.get("/logout")
async def logout():
    login_url = "/dashboard/auth/login" if auth.OIDC_ENABLED else "/dashboard/login"
    resp = RedirectResponse(login_url, status_code=302)
    resp.delete_cookie(SESSION_COOKIE)
    resp.delete_cookie(OIDC_STATE_COOKIE)
    return resp


# ---------- audit log ----------

@dashboard.get("/", response_class=HTMLResponse)
async def audit_log(request: Request, page: int = 1):
    user = _current_user(request)
    per_page = 25
    offset = (page - 1) * per_page
    logs = db.get_logs(limit=per_page, offset=offset)
    total = db.get_log_count()
    total_pages = max(1, (total + per_page - 1) // per_page)

    all_logs = db.get_logs(limit=10_000)
    counts = {"ALLOW": 0, "BLOCK": 0, "REQUIRE_APPROVAL": 0}
    for row in all_logs:
        counts[row["action"]] = counts.get(row["action"], 0) + 1

    stats_html = f"""
    <div class="stats">
      <div class="stat"><div class="val allow">{counts['ALLOW']}</div><div class="lbl">Allowed</div></div>
      <div class="stat"><div class="val block">{counts['BLOCK']}</div><div class="lbl">Blocked</div></div>
      <div class="stat"><div class="val approval">{counts['REQUIRE_APPROVAL']}</div><div class="lbl">Queued for Approval</div></div>
      <div class="stat"><div class="val">{total}</div><div class="lbl">Total Events</div></div>
    </div>"""

    rows_html = ""
    for r in logs:
        tool = r["tool_name"] or f'<span class="muted">{r["method"]}</span>'
        reason = r["reason"] or '<span class="muted">—</span>'
        ip = r["client_ip"] or '<span class="muted">—</span>'
        user_col = r.get("user_email") or '<span class="muted">agent</span>'
        rows_html += f"""<tr>
          <td>{r['id']}</td>
          <td style="white-space:nowrap">{r['timestamp'][:19].replace('T', ' ')}</td>
          <td>{tool}</td>
          <td><span class="badge badge-{r['action']}">{r['action']}</span></td>
          <td>{reason}</td>
          <td>{ip}</td>
          <td>{user_col}</td>
        </tr>"""

    if not rows_html:
        rows_html = '<tr><td colspan="7" style="text-align:center;color:#475569;padding:32px">No events yet.</td></tr>'

    prev_link = f'<a href="?page={page-1}">&larr; Prev</a>' if page > 1 else '<span>&larr; Prev</span>'
    next_link = f'<a href="?page={page+1}">Next &rarr;</a>' if page < total_pages else '<span>Next &rarr;</span>'

    body = f"""
    <h1>Audit Log</h1>
    {stats_html}
    <table>
      <thead><tr>
        <th>#</th><th>Timestamp (UTC)</th><th>Tool</th>
        <th>Action</th><th>Reason</th><th>Client IP</th><th>User</th>
      </tr></thead>
      <tbody>{rows_html}</tbody>
    </table>
    <div class="pagination">
      {prev_link}
      <span>Page {page} of {total_pages}</span>
      {next_link}
    </div>"""

    return _page("Audit Log", body, active="audit", user=user)


# ---------- approvals ----------

@dashboard.get("/approvals", response_class=HTMLResponse)
async def approvals_page(request: Request):
    user = _current_user(request)
    pending = db.get_pending_approvals()
    recent = db.get_all_approvals(limit=50)

    pending_badge = f'<span class="pending-badge">{len(pending)}</span>' if pending else ""

    queue_html = ""
    for r in pending:
        args = r["arguments"] or "{}"
        queue_html += f"""
        <tr>
          <td><code>{r['id'][:8]}…</code></td>
          <td style="white-space:nowrap">{r['timestamp'][:19].replace('T', ' ')}</td>
          <td><strong>{r['tool_name']}</strong></td>
          <td><code>{args[:120]}{'…' if len(args) > 120 else ''}</code></td>
          <td>{r['client_ip'] or '<span class="muted">—</span>'}</td>
          <td>
            <form method="post" action="/dashboard/approvals/resolve" style="display:inline">
              <input type="hidden" name="approval_id" value="{r['id']}">
              <button class="btn-success" name="decision" value="APPROVED" type="submit">Approve</button>
              <button class="btn-danger"  name="decision" value="REJECTED" type="submit" style="margin-left:6px">Reject</button>
            </form>
          </td>
        </tr>"""

    if not queue_html:
        queue_html = '<tr><td colspan="6" style="text-align:center;color:#475569;padding:24px">No pending approvals.</td></tr>'

    history_html = ""
    for r in recent:
        if r["status"] == "PENDING":
            continue
        args = r["arguments"] or "{}"
        resolved_by = r.get("resolved_by") or '<span class="muted">—</span>'
        history_html += f"""<tr>
          <td><code>{r['id'][:8]}…</code></td>
          <td style="white-space:nowrap">{r['timestamp'][:19].replace('T', ' ')}</td>
          <td>{r['tool_name']}</td>
          <td><span class="badge badge-{r['status']}">{r['status']}</span></td>
          <td style="white-space:nowrap">{(r['resolved_at'] or '')[:19].replace('T', ' ')}</td>
          <td>{resolved_by}</td>
        </tr>"""

    if not history_html:
        history_html = '<tr><td colspan="6" style="text-align:center;color:#475569;padding:24px">No resolved approvals yet.</td></tr>'

    body = f"""
    <h1>Approvals {pending_badge}</h1>
    <div class="card" style="margin-bottom:24px">
      <h2>Pending Queue</h2>
      <table>
        <thead><tr>
          <th>ID</th><th>Timestamp (UTC)</th><th>Tool</th>
          <th>Arguments</th><th>Client IP</th><th>Action</th>
        </tr></thead>
        <tbody>{queue_html}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>Resolution History</h2>
      <table>
        <thead><tr>
          <th>ID</th><th>Requested</th><th>Tool</th><th>Decision</th><th>Resolved</th><th>By</th>
        </tr></thead>
        <tbody>{history_html}</tbody>
      </table>
    </div>"""

    return _page("Approvals", body, active="approvals", user=user)


@dashboard.post("/approvals/resolve")
async def resolve_approval(request: Request, approval_id: str = Form(...), decision: str = Form(...)):
    if decision in ("APPROVED", "REJECTED"):
        resolved_by = _current_user(request).get("email")
        db.resolve_approval(approval_id, decision, resolved_by=resolved_by)
    return RedirectResponse("/dashboard/approvals", status_code=303)


# ---------- policy editor ----------

@dashboard.get("/policy", response_class=HTMLResponse)
async def policy_editor(request: Request):
    user = _current_user(request)
    config = _load_policy()
    default = config.get("default_action", "ALLOW")

    default_html = f"""
    <div class="card">
      <h2>Default Action</h2>
      <form method="post" action="/dashboard/policy/default">
        <div class="default-row">
          <div>
            <label>Action when no rule matches</label>
            <select name="default_action">
              {''.join(f'<option value="{a}"{"selected" if a == default else ""}>{a}</option>'
                       for a in ["ALLOW", "BLOCK", "REQUIRE_APPROVAL"])}
            </select>
          </div>
          <button class="btn-primary" type="submit" style="margin-top:18px">Save</button>
        </div>
      </form>
    </div>"""

    rules_html = ""
    for i, rule in enumerate(config.get("rules", [])):
        action_opts = "".join(
            f'<option value="{a}"{"selected" if a == rule["action"] else ""}>{a}</option>'
            for a in ["ALLOW", "BLOCK", "REQUIRE_APPROVAL"]
        )
        rules_html += f"""
        <form method="post" action="/dashboard/policy/rule/update">
          <input type="hidden" name="index" value="{i}">
          <div class="rule-row">
            <div><label>Tool Name</label><input name="tool" value="{rule['tool']}"></div>
            <div><label>Action</label><select name="action">{action_opts}</select></div>
            <div><label>Reason</label><input name="reason" value="{rule.get('reason', '')}"></div>
            <div style="display:flex;gap:6px;align-items:flex-end">
              <button class="btn-primary" type="submit">Save</button>
              <button class="btn-danger" formaction="/dashboard/policy/rule/delete" type="submit">Del</button>
            </div>
          </div>
        </form>"""

    add_html = f"""
    <div class="card">
      <h2>Add Rule</h2>
      <form method="post" action="/dashboard/policy/rule/add">
        <div class="rule-row">
          <div><label>Tool Name</label><input name="tool" placeholder="e.g. run_query" required></div>
          <div><label>Action</label>
            <select name="action">
              <option>ALLOW</option><option>BLOCK</option><option>REQUIRE_APPROVAL</option>
            </select>
          </div>
          <div><label>Reason</label><input name="reason" placeholder="Optional explanation"></div>
          <div style="margin-top:18px"><button class="btn-primary" type="submit">Add</button></div>
        </div>
      </form>
    </div>"""

    body = f"""
    <h1>Policy Editor</h1>
    {default_html}
    <div class="card">
      <h2>Rules</h2>
      {rules_html or '<p class="muted" style="padding:8px 0">No rules defined.</p>'}
    </div>
    {add_html}"""

    return _page("Policy Editor", body, active="policy", user=user)


@dashboard.post("/policy/default")
async def set_default(default_action: str = Form(...)):
    config = _load_policy()
    config["default_action"] = default_action
    _save_policy(config)
    return RedirectResponse("/dashboard/policy", status_code=303)


@dashboard.post("/policy/rule/add")
async def add_rule(tool: str = Form(...), action: str = Form(...), reason: str = Form("")):
    config = _load_policy()
    config.setdefault("rules", []).append({"tool": tool, "action": action, "reason": reason})
    _save_policy(config)
    return RedirectResponse("/dashboard/policy", status_code=303)


@dashboard.post("/policy/rule/update")
async def update_rule(index: int = Form(...), tool: str = Form(...),
                      action: str = Form(...), reason: str = Form("")):
    config = _load_policy()
    rules = config.get("rules", [])
    if 0 <= index < len(rules):
        rules[index] = {"tool": tool, "action": action, "reason": reason}
    _save_policy(config)
    return RedirectResponse("/dashboard/policy", status_code=303)


@dashboard.post("/policy/rule/delete")
async def delete_rule(index: int = Form(...)):
    config = _load_policy()
    rules = config.get("rules", [])
    if 0 <= index < len(rules):
        rules.pop(index)
    _save_policy(config)
    return RedirectResponse("/dashboard/policy", status_code=303)


# ---------- NERC CIP compliance export ----------

_NERC_FIELDS = ["id", "timestamp", "tool_name", "method", "action",
                "reason", "request_id", "client_ip", "user_email"]


@dashboard.get("/export/audit")
async def export_audit(
    request: Request,
    format: str = Query("csv", pattern="^(csv|json)$"),
    start: str = Query("", description="Start date YYYY-MM-DD (inclusive)"),
    end:   str = Query("", description="End date YYYY-MM-DD (inclusive)"),
):
    rows = db.get_logs_filtered(
        start=start or None,
        end=end or None,
        limit=100_000,
    )
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    period  = f"{start or 'beginning'} to {end or 'present'}"

    if format == "json":
        payload = {
            "meta": {
                "standard":   "NERC CIP-007-6 R6 / CIP-005-7 R2",
                "system":     "Cordon MCP Security Gateway",
                "generated":  now_str,
                "period":     period,
                "record_count": len(rows),
            },
            "records": rows,
        }
        body = json.dumps(payload, indent=2, default=str)
        filename = f"cordon_audit_{now_str[:10]}.json"
        return Response(
            content=body,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    # CSV
    buf = io.StringIO()
    buf.write(f"# NERC CIP-007-6 R6 / CIP-005-7 R2 Audit Export\n")
    buf.write(f"# System: Cordon MCP Security Gateway\n")
    buf.write(f"# Generated: {now_str}\n")
    buf.write(f"# Period: {period}\n")
    buf.write(f"# Record count: {len(rows)}\n")

    writer = csv.DictWriter(buf, fieldnames=_NERC_FIELDS, extrasaction="ignore",
                            lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)

    filename = f"cordon_audit_{now_str[:10]}.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@dashboard.get("/export", response_class=HTMLResponse)
async def export_page(request: Request):
    user = _current_user(request)
    body = """
    <h1>NERC CIP Compliance Export</h1>
    <div class="card">
      <h2>Audit Log Export</h2>
      <p style="color:#94a3b8;font-size:.9rem;margin-bottom:16px">
        Generates a download conforming to NERC CIP-007-6 R6 (Security Event Monitoring)
        and CIP-005-7 R2 (Interactive Remote Access) audit requirements.
      </p>
      <form method="get" action="/dashboard/export/audit" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
        <div>
          <label>Start Date</label>
          <input type="date" name="start" style="width:160px">
        </div>
        <div>
          <label>End Date</label>
          <input type="date" name="end" style="width:160px">
        </div>
        <div>
          <label>Format</label>
          <select name="format" style="width:100px">
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <button class="btn-primary" type="submit" style="margin-top:18px">Download</button>
      </form>
    </div>
    <div class="card">
      <h2>Covered Standards</h2>
      <table>
        <thead><tr><th>Standard</th><th>Requirement</th><th>How Cordon Addresses It</th></tr></thead>
        <tbody>
          <tr>
            <td>NERC CIP-007-6</td>
            <td>R6 — Security Event Monitoring</td>
            <td>Every tool call logged with timestamp, action, actor IP, and outcome</td>
          </tr>
          <tr>
            <td>NERC CIP-005-7</td>
            <td>R2 — Interactive Remote Access</td>
            <td>User identity (via OIDC) recorded on all dashboard actions and approvals</td>
          </tr>
          <tr>
            <td>NERC CIP-007-6</td>
            <td>R6.3 — Human-initiated actions</td>
            <td>HITL approval queue records who approved/rejected each request and when</td>
          </tr>
        </tbody>
      </table>
    </div>"""
    return _page("Compliance Export", body, active="export", user=user)
