import { config } from "./config.ts";

// ---------- types ----------

export interface AuditRow {
  id: number;
  timestamp: string;
  tool_name: string | null;
  method: string;
  action: string;
  reason: string | null;
  request_id: string | null;
  client_ip: string | null;
  user_email: string | null;
}

export interface ApprovalRow {
  id: string;
  timestamp: string;
  tool_name: string;
  arguments: string | null;
  request_id: string | null;
  client_ip: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  resolved_at: string | null;
  resolved_by: string | null;
}

// ---------- connection ----------

// ---------- raw SQL helper (keeps dual-backend simple) ----------

let _sqlite: import("bun:sqlite").Database | null = null;
let _pgClient: ReturnType<typeof import("postgres").default> | null = null;

async function connect() {
  if (config.DATABASE_URL) {
    if (!_pgClient) {
      const postgres = (await import("postgres")).default;
      _pgClient = postgres(config.DATABASE_URL);
    }
    return { type: "pg" as const, client: _pgClient };
  }
  if (!_sqlite) {
    const { Database } = await import("bun:sqlite");
    _sqlite = new Database(config.CORDON_DB);
    _sqlite.run("PRAGMA journal_mode = WAL");
  }
  return { type: "sqlite" as const, client: _sqlite };
}

// ---------- schema ----------

export async function initDb() {
  const { type, client } = await connect();

  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    db.run(`
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
      )
    `);
    db.run(`
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
      )
    `);
    // Safe migrations
    for (const sql of [
      "ALTER TABLE audit_log ADD COLUMN user_email TEXT",
      "ALTER TABLE approval_queue ADD COLUMN resolved_by TEXT",
    ]) {
      try {
        db.run(sql);
      } catch {
        /* column exists */
      }
    }
  } else {
    const pg = client as ReturnType<typeof import("postgres").default>;
    await pg`
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
      )
    `;
    await pg`
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
      )
    `;
    await pg`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_email TEXT`;
    await pg`ALTER TABLE approval_queue ADD COLUMN IF NOT EXISTS resolved_by TEXT`;
  }
}

// ---------- audit log ----------

export async function logEvent(params: {
  method: string;
  action: string;
  toolName?: string;
  reason?: string;
  requestId?: string | number | null;
  clientIp?: string | null;
  userEmail?: string | null;
}) {
  const { type, client } = await connect();
  const ts = new Date().toISOString();

  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    db.run(
      `INSERT INTO audit_log (timestamp, tool_name, method, action, reason, request_id, client_ip, user_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ts,
        params.toolName ?? null,
        params.method,
        params.action,
        params.reason ?? null,
        params.requestId != null ? String(params.requestId) : null,
        params.clientIp ?? null,
        params.userEmail ?? null,
      ],
    );
  } else {
    const pg = client as ReturnType<typeof import("postgres").default>;
    await pg`
      INSERT INTO audit_log (timestamp, tool_name, method, action, reason, request_id, client_ip, user_email)
      VALUES (${ts}, ${params.toolName ?? null}, ${params.method}, ${params.action},
              ${params.reason ?? null}, ${params.requestId != null ? String(params.requestId) : null},
              ${params.clientIp ?? null}, ${params.userEmail ?? null})
    `;
  }
}

export async function getLogs(limit = 100, offset = 0): Promise<AuditRow[]> {
  const { type, client } = await connect();
  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    return db
      .query<AuditRow, [number, number]>(
        "SELECT * FROM audit_log ORDER BY id DESC LIMIT ? OFFSET ?",
      )
      .all(limit, offset);
  }
  const pg = client as ReturnType<typeof import("postgres").default>;
  return pg`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${limit} OFFSET ${offset}` as Promise<
    AuditRow[]
  >;
}

export async function getLogsFiltered(params: {
  start?: string;
  end?: string;
  limit?: number;
}): Promise<AuditRow[]> {
  const { start, end, limit = 10_000 } = params;
  const { type, client } = await connect();

  const clauses: string[] = [];
  const args: string[] = [];

  if (start) {
    clauses.push("timestamp >= ?");
    args.push(start);
  }
  if (end) {
    const endDt = new Date(new Date(end).getTime() + 86_400_000).toISOString().slice(0, 10);
    clauses.push("timestamp < ?");
    args.push(endDt);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    return db
      .query<AuditRow, string[]>(`SELECT * FROM audit_log ${where} ORDER BY timestamp ASC LIMIT ?`)
      .all(...args, String(limit));
  }

  const pg = client as ReturnType<typeof import("postgres").default>;
  // Postgres path uses tagged template — build dynamically
  const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp ASC LIMIT ${limit}`;
  return pg.unsafe(sql, args) as Promise<AuditRow[]>;
}

export async function getLogCount(): Promise<number> {
  const { type, client } = await connect();
  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    return (
      db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM audit_log").get()?.count ?? 0
    );
  }
  const pg = client as ReturnType<typeof import("postgres").default>;
  const [row] = await pg`SELECT COUNT(*)::int as count FROM audit_log`;
  return (row as { count: number }).count;
}

// ---------- approval queue ----------

export async function queueApproval(params: {
  id: string;
  toolName: string;
  arguments: string;
  requestId?: string | number | null;
  clientIp?: string | null;
}) {
  const { type, client } = await connect();
  const ts = new Date().toISOString();

  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    db.run(
      `INSERT INTO approval_queue (id, timestamp, tool_name, arguments, request_id, client_ip, status)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING')`,
      [
        params.id,
        ts,
        params.toolName,
        params.arguments,
        params.requestId != null ? String(params.requestId) : null,
        params.clientIp ?? null,
      ],
    );
  } else {
    const pg = client as ReturnType<typeof import("postgres").default>;
    await pg`
      INSERT INTO approval_queue (id, timestamp, tool_name, arguments, request_id, client_ip, status)
      VALUES (${params.id}, ${ts}, ${params.toolName}, ${params.arguments},
              ${params.requestId != null ? String(params.requestId) : null},
              ${params.clientIp ?? null}, 'PENDING')
    `;
  }
}

export async function getApproval(id: string): Promise<ApprovalRow | null> {
  const { type, client } = await connect();
  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    return (
      db.query<ApprovalRow, [string]>("SELECT * FROM approval_queue WHERE id = ?").get(id) ?? null
    );
  }
  const pg = client as ReturnType<typeof import("postgres").default>;
  const [row] = await pg`SELECT * FROM approval_queue WHERE id = ${id}`;
  return (row as ApprovalRow) ?? null;
}

export async function resolveApproval(
  id: string,
  status: "APPROVED" | "REJECTED",
  resolvedBy?: string,
) {
  const { type, client } = await connect();
  const ts = new Date().toISOString();
  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    db.run("UPDATE approval_queue SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ?", [
      status,
      ts,
      resolvedBy ?? null,
      id,
    ]);
  } else {
    const pg = client as ReturnType<typeof import("postgres").default>;
    await pg`UPDATE approval_queue SET status = ${status}, resolved_at = ${ts}, resolved_by = ${resolvedBy ?? null} WHERE id = ${id}`;
  }
}

export async function getPendingApprovals(): Promise<ApprovalRow[]> {
  const { type, client } = await connect();
  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    return db
      .query<ApprovalRow, []>(
        "SELECT * FROM approval_queue WHERE status = 'PENDING' ORDER BY timestamp ASC",
      )
      .all();
  }
  const pg = client as ReturnType<typeof import("postgres").default>;
  return pg`SELECT * FROM approval_queue WHERE status = 'PENDING' ORDER BY timestamp ASC` as Promise<
    ApprovalRow[]
  >;
}

export async function getAllApprovals(limit = 50): Promise<ApprovalRow[]> {
  const { type, client } = await connect();
  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    return db
      .query<ApprovalRow, [number]>("SELECT * FROM approval_queue ORDER BY timestamp DESC LIMIT ?")
      .all(limit);
  }
  const pg = client as ReturnType<typeof import("postgres").default>;
  return pg`SELECT * FROM approval_queue ORDER BY timestamp DESC LIMIT ${limit}` as Promise<
    ApprovalRow[]
  >;
}

export async function pendingApprovalCount(): Promise<number> {
  const { type, client } = await connect();
  if (type === "sqlite") {
    const db = client as import("bun:sqlite").Database;
    return (
      db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) as count FROM approval_queue WHERE status = 'PENDING'",
        )
        .get()?.count ?? 0
    );
  }
  const pg = client as ReturnType<typeof import("postgres").default>;
  const [row] =
    await pg`SELECT COUNT(*)::int as count FROM approval_queue WHERE status = 'PENDING'`;
  return (row as { count: number }).count;
}
