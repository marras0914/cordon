import type { SessionUser } from "./auth.ts";

const PAGES = [
  { path: "/dashboard/",         label: "Audit Log",  key: "audit"     },
  { path: "/dashboard/approvals", label: "Approvals",  key: "approvals" },
  { path: "/dashboard/policy",    label: "Policy",     key: "policy"    },
  { path: "/dashboard/export",    label: "Export",     key: "export"    },
] as const;

export function nav(active: string, user: SessionUser | null): string {
  const links = PAGES.map(({ path, label, key }) =>
    `<a href="${path}"${key === active ? ' class="active"' : ""}>${label}</a>`
  ).join("");

  const userInfo = user
    ? `<span class="user">${user.email}</span> <a href="/dashboard/logout">Logout</a>`
    : "";

  return `<nav>${links}<span class="nav-right">${userInfo}</span></nav>`;
}

export function layout(title: string, body: string, active: string, user: SessionUser | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — Cordon</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
    body { font-family: system-ui, sans-serif; font-size: 14px; background: #f5f5f5; color: #222 }
    nav { background: #1a1a2e; color: #fff; padding: 0 24px; display: flex; align-items: center; gap: 4px }
    nav a { color: #ccc; text-decoration: none; padding: 14px 12px; display: block }
    nav a:hover, nav a.active { color: #fff; background: #ffffff18 }
    .nav-right { margin-left: auto; color: #aaa; font-size: 12px }
    .nav-right a { color: #aaa; font-size: 12px }
    main { padding: 24px; max-width: 1200px; margin: 0 auto }
    h2 { margin-bottom: 16px; font-size: 18px }
    h2 small { font-size: 13px; color: #666; font-weight: normal }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 6px; overflow: hidden; box-shadow: 0 1px 3px #0001 }
    th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee }
    th { background: #f8f8f8; font-weight: 600; font-size: 12px; text-transform: uppercase; color: #666 }
    tr:last-child td { border-bottom: none }
    code, pre { font-family: monospace; font-size: 12px; background: #f0f0f0; padding: 2px 5px; border-radius: 3px }
    pre { padding: 8px; white-space: pre-wrap; word-break: break-all; max-width: 300px }
    .badge { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase }
    .badge-allow { background: #d1fae5; color: #065f46 }
    .badge-block { background: #fee2e2; color: #991b1b }
    .badge-require_approval { background: #fef3c7; color: #92400e }
    .badge-approved { background: #d1fae5; color: #065f46 }
    .badge-rejected { background: #fee2e2; color: #991b1b }
    .badge-pending { background: #fef3c7; color: #92400e }
    button, input[type=submit] { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; font-size: 13px }
    .btn-approve { background: #10b981; color: #fff }
    .btn-reject  { background: #ef4444; color: #fff }
    input, select, textarea { padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px }
    .pagination { margin-top: 16px; display: flex; gap: 12px }
    .pagination a { color: #4f46e5; text-decoration: none }
    .login-box { max-width: 360px; margin: 80px auto; background: #fff; padding: 32px; border-radius: 8px; box-shadow: 0 2px 8px #0002 }
    .login-box h2 { margin-bottom: 20px }
    .login-box input { width: 100%; margin-bottom: 12px }
    .login-box button { width: 100%; background: #4f46e5; color: #fff }
    .error { color: #b91c1c; background: #fee2e2; padding: 8px 12px; border-radius: 4px; margin-bottom: 12px }
    label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 600; color: #555 }
    form { display: flex; flex-direction: column; gap: 12px }
  </style>
</head>
<body>
  ${nav(active, user)}
  <main>${body}</main>
</body>
</html>`;
}
