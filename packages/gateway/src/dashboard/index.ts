import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";
import * as db from "../db.ts";
import * as auth from "./auth.ts";
import { config } from "../config.ts";
import { layout, nav } from "./views.ts";

export const dashboard = new Hono();

// ---------- auth middleware ----------

dashboard.use("*", async (c, next) => {
  const path = c.req.path;
  if (path.includes("/auth/") || path.endsWith("/login") || path.endsWith("/logout")) {
    return next();
  }

  const token = getCookie(c, auth.SESSION_COOKIE);

  if (auth.oidcEnabled) {
    const user = await auth.verifySession(token);
    if (!user) return c.redirect("/dashboard/auth/login", 302);
    c.set("user", user);
  } else if (config.CORDON_DASHBOARD_KEY) {
    if (token !== config.CORDON_DASHBOARD_KEY) return c.redirect("/dashboard/login", 302);
    c.set("user", { sub: "admin", email: "admin", name: "Admin" });
  } else {
    c.set("user", null);
  }

  return next();
});

// ---------- audit log ----------

dashboard.get("/", async (c) => {
  const page = Number(c.req.query("page") ?? "1");
  const limit = 50;
  const offset = (page - 1) * limit;
  const logs = await db.getLogs(limit, offset);
  const total = await db.getLogCount();
  const user = c.get("user") as auth.SessionUser | null;

  const rows = logs.map((r) => `
    <tr>
      <td>${r.timestamp?.slice(0, 19).replace("T", " ")}</td>
      <td><code>${r.tool_name ?? "—"}</code></td>
      <td><span class="badge badge-${r.action.toLowerCase()}">${r.action}</span></td>
      <td>${r.reason ?? ""}</td>
      <td>${r.client_ip ?? ""}</td>
      <td>${r.user_email ?? ""}</td>
    </tr>`).join("");

  const body = `
    <h2>Audit Log <small>(${total} total)</small></h2>
    <table>
      <thead><tr><th>Time</th><th>Tool</th><th>Action</th><th>Reason</th><th>IP</th><th>User</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="pagination">
      ${page > 1 ? `<a href="?page=${page - 1}">← Previous</a>` : ""}
      ${offset + limit < total ? `<a href="?page=${page + 1}">Next →</a>` : ""}
    </div>`;

  return c.html(layout("Audit Log", body, "audit", user));
});

// ---------- approvals ----------

dashboard.get("/approvals", async (c) => {
  const pending = await db.getPendingApprovals();
  const history = await db.getAllApprovals(20);
  const user = c.get("user") as auth.SessionUser | null;

  const pendingRows = pending.map((r) => `
    <tr>
      <td>${r.timestamp.slice(0, 19).replace("T", " ")}</td>
      <td><code>${r.tool_name}</code></td>
      <td><pre>${r.arguments ?? ""}</pre></td>
      <td>
        <form method="post" action="/dashboard/approvals/${r.id}/resolve" style="display:inline">
          <input type="hidden" name="status" value="APPROVED">
          <button type="submit" class="btn-approve">Approve</button>
        </form>
        <form method="post" action="/dashboard/approvals/${r.id}/resolve" style="display:inline">
          <input type="hidden" name="status" value="REJECTED">
          <button type="submit" class="btn-reject">Reject</button>
        </form>
      </td>
    </tr>`).join("");

  const historyRows = history
    .filter((r) => r.status !== "PENDING")
    .map((r) => `
      <tr>
        <td>${r.resolved_at?.slice(0, 19).replace("T", " ") ?? "—"}</td>
        <td><code>${r.tool_name}</code></td>
        <td><span class="badge badge-${r.status.toLowerCase()}">${r.status}</span></td>
        <td>${r.resolved_by ?? ""}</td>
      </tr>`).join("");

  const body = `
    <h2>Pending Approvals (${pending.length})</h2>
    <table>
      <thead><tr><th>Time</th><th>Tool</th><th>Arguments</th><th>Action</th></tr></thead>
      <tbody>${pendingRows || '<tr><td colspan="4">No pending approvals</td></tr>'}</tbody>
    </table>
    <h2>History</h2>
    <table>
      <thead><tr><th>Resolved</th><th>Tool</th><th>Status</th><th>By</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>`;

  return c.html(layout("Approvals", body, "approvals", user));
});

dashboard.post("/approvals/:id/resolve", async (c) => {
  const { id } = c.req.param();
  const { status } = await c.req.parseBody() as { status: "APPROVED" | "REJECTED" };
  const user = c.get("user") as auth.SessionUser | null;
  await db.resolveApproval(id, status, user?.email);
  return c.redirect("/dashboard/approvals", 302);
});

// ---------- policy editor ----------

dashboard.get("/policy", (c) => {
  const user = c.get("user") as auth.SessionUser | null;
  const content = readFileSync("policy.yaml", "utf8");
  const body = `
    <h2>Policy Editor</h2>
    <p>Changes take effect immediately — no restart needed.</p>
    <form method="post" action="/dashboard/policy">
      <textarea name="policy" rows="25" style="width:100%;font-family:monospace">${content}</textarea>
      <br><button type="submit">Save Policy</button>
    </form>`;
  return c.html(layout("Policy", body, "policy", user));
});

dashboard.post("/policy", async (c) => {
  const { policy: raw } = await c.req.parseBody() as { policy: string };
  try {
    yaml.load(raw); // validate
    writeFileSync("policy.yaml", raw, "utf8");
    return c.redirect("/dashboard/policy?saved=1", 302);
  } catch (err) {
    const user = c.get("user") as auth.SessionUser | null;
    const body = `
      <h2>Policy Editor</h2>
      <p class="error">Invalid YAML: ${err}</p>
      <form method="post" action="/dashboard/policy">
        <textarea name="policy" rows="25" style="width:100%;font-family:monospace">${raw}</textarea>
        <br><button type="submit">Save Policy</button>
      </form>`;
    return c.html(layout("Policy", body, "policy", user));
  }
});

// ---------- NERC CIP export ----------

const NERC_FIELDS = ["id", "timestamp", "tool_name", "method", "action", "reason", "request_id", "client_ip", "user_email"] as const;

dashboard.get("/export/audit", async (c) => {
  const format = c.req.query("format") ?? "csv";
  const start  = c.req.query("start") || undefined;
  const end    = c.req.query("end")   || undefined;
  const rows   = await db.getLogsFiltered({ start, end, limit: 100_000 });
  const now    = new Date().toISOString().slice(0, 19) + "Z";
  const period = `${start ?? "beginning"} to ${end ?? "present"}`;
  const date   = now.slice(0, 10);

  if (format === "json") {
    const payload = {
      meta: { standard: "NERC CIP-007-6 R6 / CIP-005-7 R2", system: "Cordon MCP Security Gateway", generated: now, period, record_count: rows.length },
      records: rows,
    };
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cordon_audit_${date}.json"`,
      },
    });
  }

  const lines = [
    `# NERC CIP-007-6 R6 / CIP-005-7 R2 Audit Export`,
    `# System: Cordon MCP Security Gateway`,
    `# Generated: ${now}`,
    `# Period: ${period}`,
    `# Record count: ${rows.length}`,
    NERC_FIELDS.join(","),
    ...rows.map((r) => NERC_FIELDS.map((f) => JSON.stringify(r[f] ?? "")).join(",")),
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="cordon_audit_${date}.csv"`,
    },
  });
});

dashboard.get("/export", (c) => {
  const user = c.get("user") as auth.SessionUser | null;
  const body = `
    <h2>Compliance Export</h2>
    <p>Download audit log for NERC CIP-007-6 R6 / CIP-005-7 R2 review.</p>
    <form method="get" action="/dashboard/export/audit" style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">
      <label>Start date<br><input type="date" name="start"></label>
      <label>End date<br><input type="date" name="end"></label>
      <label>Format<br>
        <select name="format">
          <option value="csv">CSV</option>
          <option value="json">JSON</option>
        </select>
      </label>
      <button type="submit">Download</button>
    </form>`;
  return c.html(layout("Compliance Export", body, "export", user));
});

// ---------- simple key auth ----------

dashboard.get("/login", (c) => {
  const body = `
    <div class="login-box">
      <h2>Dashboard Login</h2>
      <form method="post" action="/dashboard/login">
        <input type="password" name="key" placeholder="Dashboard key" required>
        <button type="submit">Sign in</button>
      </form>
    </div>`;
  return c.html(layout("Login", body, "", null));
});

dashboard.post("/login", async (c) => {
  const { key } = await c.req.parseBody() as { key: string };
  if (key === config.CORDON_DASHBOARD_KEY) {
    setCookie(c, auth.SESSION_COOKIE, key, { httpOnly: true, sameSite: "Lax", path: "/" });
    return c.redirect("/dashboard/", 302);
  }
  return c.redirect("/dashboard/login?error=1", 302);
});

dashboard.get("/logout", (c) => {
  deleteCookie(c, auth.SESSION_COOKIE, { path: "/" });
  return c.redirect("/dashboard/login", 302);
});

// ---------- OIDC routes ----------

dashboard.get("/auth/login", async (c) => {
  if (!auth.oidcEnabled) return c.redirect("/dashboard/login", 302);
  const { url, stateCookie } = await auth.getAuthorizationUrl();
  c.header("Set-Cookie", stateCookie);
  return c.redirect(url, 302);
});

dashboard.get("/auth/callback", async (c) => {
  const code  = c.req.query("code") ?? "";
  const state = c.req.query("state") ?? "";
  const raw   = getCookie(c, auth.STATE_COOKIE) ?? "";

  let parsed: { state: string; verifier: string };
  try { parsed = JSON.parse(decodeURIComponent(raw)); }
  catch { return c.text("Invalid state cookie", 400); }

  if (parsed.state !== state) return c.text("State mismatch", 400);

  try {
    const user = await auth.exchangeCode(code, parsed.verifier);
    const token = await auth.createSession(user);
    setCookie(c, auth.SESSION_COOKIE, token, { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 8 * 3600 });
    deleteCookie(c, auth.STATE_COOKIE, { path: "/" });
    return c.redirect("/dashboard/", 302);
  } catch (err) {
    return c.text(`Authentication failed: ${err}`, 401);
  }
});
