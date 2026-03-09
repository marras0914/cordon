import { describe, test, expect, vi, beforeEach } from "vitest";

// ── mocks must be declared before imports ────────────────────────────────────

vi.mock("../src/config.ts", () => ({
  config: {
    REAL_MCP_SERVER: "http://localhost:8001",
    CORDON_OPA_URL: undefined,
    CORDON_REDACT_PII: false,
    CORDON_RATE_LIMIT: 0,   // disabled — tested separately
    CORDON_RATE_WINDOW: 60,
    CORDON_WEBHOOK_URL: undefined,
    CORDON_ALERT_ON_BLOCK: false,
    CORDON_ALERT_QUEUE_THRESHOLD: 0,
  },
  oidcEnabled: false,
}));

vi.mock("../src/db.ts", () => ({
  logEvent: vi.fn(async () => {}),
  queueApproval: vi.fn(async () => {}),
  getApproval: vi.fn(async () => null),
  pendingApprovalCount: vi.fn(async () => 0),
}));

vi.mock("../src/alerting.ts", () => ({
  onBlock: vi.fn(),
  onApprovalQueued: vi.fn(),
}));

vi.mock("../src/rate-limit.ts", () => ({
  check: vi.fn(() => ({ allowed: true, retryAfter: 0 })),
  reset: vi.fn(),
}));

vi.mock("../src/pii.ts", () => ({
  redact: vi.fn((v: unknown) => v),
}));

vi.mock("../src/policy.ts", () => ({
  evaluatePolicy: vi.fn(async () => ({ action: "ALLOW" as const, reason: "" })),
}));

import { proxy } from "../src/proxy.ts";
import * as dbMock from "../src/db.ts";
import * as rateLimitMock from "../src/rate-limit.ts";
import * as policyMod from "../src/policy.ts";

// ── helpers ───────────────────────────────────────────────────────────────────

function rpcBody(method: string, toolName: string, args = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params: { name: toolName, arguments: args } });
}

function mockUpstream(body: unknown, status = 200) {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  }));
}

async function post(body: string, headers: Record<string, string> = {}) {
  return proxy.request("/messages", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "ALLOW", reason: "" });
  vi.mocked(rateLimitMock.check).mockReturnValue({ allowed: true, retryAfter: 0 });
  vi.mocked(dbMock.getApproval).mockResolvedValue(null);
  vi.mocked(dbMock.pendingApprovalCount).mockResolvedValue(0);
});

// ── ALLOW ─────────────────────────────────────────────────────────────────────

describe("ALLOW", () => {
  test("forwards to upstream and returns result", async () => {
    mockUpstream({ jsonrpc: "2.0", id: 1, result: { content: "file data" } });
    const res = await post(rpcBody("tools/call", "read_file"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toEqual({ content: "file data" });
  });

  test("logs ALLOW event", async () => {
    mockUpstream({ jsonrpc: "2.0", id: 1, result: {} });
    await post(rpcBody("tools/call", "read_file"));
    expect(vi.mocked(dbMock.logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ALLOW" })
    );
  });

  test("non-tools/call methods are forwarded without policy check", async () => {
    mockUpstream({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    const res = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(200);
    expect(vi.mocked(policyMod.evaluatePolicy)).not.toHaveBeenCalled();
  });
});

// ── BLOCK ─────────────────────────────────────────────────────────────────────

describe("BLOCK", () => {
  test("returns -32001 error", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "BLOCK", reason: "Destructive" });
    const res = await post(rpcBody("tools/call", "delete_file"));
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
  });

  test("error message includes reason", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "BLOCK", reason: "Not allowed here" });
    const res = await post(rpcBody("tools/call", "delete_file"));
    const body = await res.json();
    expect(body.error.message).toContain("Not allowed here");
  });

  test("logs BLOCK event", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "BLOCK", reason: "reason" });
    await post(rpcBody("tools/call", "delete_file"));
    expect(vi.mocked(dbMock.logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "BLOCK", toolName: "delete_file" })
    );
  });

  test("does not forward to upstream", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "BLOCK", reason: "reason" });
    globalThis.fetch = vi.fn();
    await post(rpcBody("tools/call", "delete_file"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

// ── RATE LIMIT ────────────────────────────────────────────────────────────────

describe("rate limit", () => {
  test("returns -32005 when rate limited", async () => {
    vi.mocked(rateLimitMock.check).mockReturnValue({ allowed: false, retryAfter: 30 });
    const res = await post(rpcBody("tools/call", "read_file"));
    const body = await res.json();
    expect(body.error.code).toBe(-32005);
  });

  test("retry_after included in message", async () => {
    vi.mocked(rateLimitMock.check).mockReturnValue({ allowed: false, retryAfter: 30 });
    const res = await post(rpcBody("tools/call", "read_file"));
    const body = await res.json();
    expect(body.error.message).toContain("30");
  });

  test("logs rate limit as BLOCK", async () => {
    vi.mocked(rateLimitMock.check).mockReturnValue({ allowed: false, retryAfter: 10 });
    await post(rpcBody("tools/call", "read_file"));
    expect(vi.mocked(dbMock.logEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ action: "BLOCK", reason: "Rate limit exceeded" })
    );
  });
});

// ── REQUIRE_APPROVAL ──────────────────────────────────────────────────────────

describe("REQUIRE_APPROVAL", () => {
  test("queues and returns -32002 with approval ID", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "REQUIRE_APPROVAL", reason: "Needs sign-off" });
    const res = await post(rpcBody("tools/call", "execute_shell"));
    const body = await res.json();
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toMatch(/X-Cordon-Approval-Id:/);
    expect(vi.mocked(dbMock.queueApproval)).toHaveBeenCalledOnce();
  });

  test("APPROVED: forwards to upstream", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "REQUIRE_APPROVAL", reason: "" });
    vi.mocked(dbMock.getApproval).mockResolvedValue({
      id: "test-uuid", status: "APPROVED", tool_name: "execute_shell",
      timestamp: "", arguments: null, request_id: null, client_ip: null,
      resolved_at: null, resolved_by: null,
    });
    mockUpstream({ jsonrpc: "2.0", id: 1, result: { ok: true } });
    const res = await post(rpcBody("tools/call", "execute_shell"), {
      "X-Cordon-Approval-Id": "test-uuid",
    });
    const body = await res.json();
    expect(body.result).toEqual({ ok: true });
  });

  test("REJECTED: returns -32001", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "REQUIRE_APPROVAL", reason: "" });
    vi.mocked(dbMock.getApproval).mockResolvedValue({
      id: "test-uuid", status: "REJECTED", tool_name: "execute_shell",
      timestamp: "", arguments: null, request_id: null, client_ip: null,
      resolved_at: null, resolved_by: null,
    });
    const res = await post(rpcBody("tools/call", "execute_shell"), {
      "X-Cordon-Approval-Id": "test-uuid",
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32001);
    expect(body.error.message).toContain("rejected");
  });

  test("PENDING: returns same -32002 with same ID", async () => {
    vi.mocked(policyMod.evaluatePolicy).mockResolvedValue({ action: "REQUIRE_APPROVAL", reason: "" });
    vi.mocked(dbMock.getApproval).mockResolvedValue({
      id: "test-uuid", status: "PENDING", tool_name: "execute_shell",
      timestamp: "", arguments: null, request_id: null, client_ip: null,
      resolved_at: null, resolved_by: null,
    });
    const res = await post(rpcBody("tools/call", "execute_shell"), {
      "X-Cordon-Approval-Id": "test-uuid",
    });
    const body = await res.json();
    expect(body.error.code).toBe(-32002);
    expect(body.error.message).toContain("test-uuid");
  });
});

// ── backend unreachable ───────────────────────────────────────────────────────

describe("backend unreachable", () => {
  test("returns -32003 when upstream throws", async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const res = await post(rpcBody("tools/call", "read_file"));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe(-32003);
  });
});
