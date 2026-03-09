import { describe, expect, test, vi } from "vitest";
const mock = vi.fn;
import {
  ApprovalTimeout,
  CordonClient,
  CordonError,
  PolicyBlocked,
  RateLimited,
} from "../src/index.ts";

const APPROVAL_ID = "550e8400-e29b-41d4-a716-446655440000";
const APPROVAL_MSG = `Approval required. Retry with header X-Cordon-Approval-Id: ${APPROVAL_ID}`;

function mockFetch(...responses: object[]) {
  let i = 0;
  return mock(() =>
    Promise.resolve({
      json: () => Promise.resolve(responses[i++] ?? responses.at(-1)),
    }),
  );
}

const client = new CordonClient({ baseUrl: "http://localhost:8000", pollInterval: 0 });

describe("CordonClient.callTool", () => {
  test("returns result on success", async () => {
    globalThis.fetch = mockFetch({ jsonrpc: "2.0", id: 1, result: { content: "ok" } });
    const result = await client.callTool("read_file", { path: "/etc/hosts" });
    expect(result).toEqual({ content: "ok" });
  });

  test("sends correct JSON-RPC payload", async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = mock((_, init) => {
      captured = init as RequestInit;
      return Promise.resolve({ json: () => Promise.resolve({ jsonrpc: "2.0", result: {} }) });
    });
    await client.callTool("my_tool", { x: 1 });
    const body = JSON.parse(captured?.body as string);
    expect(body.method).toBe("tools/call");
    expect(body.params.name).toBe("my_tool");
    expect(body.params.arguments).toEqual({ x: 1 });
  });

  test("posts to /messages endpoint", async () => {
    let url = "";
    globalThis.fetch = mock((u) => {
      url = u as string;
      return Promise.resolve({ json: () => Promise.resolve({ jsonrpc: "2.0", result: {} }) });
    });
    await client.callTool("t", {});
    expect(url).toBe("http://localhost:8000/messages");
  });
});

describe("PolicyBlocked", () => {
  test("raises on -32001", async () => {
    globalThis.fetch = mockFetch({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Blocked: reason" },
    });
    await expect(client.callTool("delete_file", {})).rejects.toBeInstanceOf(PolicyBlocked);
  });

  test("includes tool name and reason", async () => {
    globalThis.fetch = mockFetch({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Destructive operation" },
    });
    const err = (await client.callTool("delete_file", {}).catch((e) => e)) as PolicyBlocked;
    expect(err.toolName).toBe("delete_file");
    expect(err.reason).toContain("Destructive operation");
  });
});

describe("RateLimited", () => {
  test("raises on -32005", async () => {
    globalThis.fetch = mockFetch({
      jsonrpc: "2.0",
      error: { code: -32005, message: "Retry after 30s." },
    });
    await expect(client.callTool("t", {})).rejects.toBeInstanceOf(RateLimited);
  });

  test("parses retry_after", async () => {
    globalThis.fetch = mockFetch({
      jsonrpc: "2.0",
      error: { code: -32005, message: "rate limit. Retry after 45s." },
    });
    const err = (await client.callTool("t", {}).catch((e) => e)) as RateLimited;
    expect(err.retryAfter).toBe(45);
  });
});

describe("HITL approval", () => {
  test("polls and returns result on approval", async () => {
    globalThis.fetch = mockFetch(
      { jsonrpc: "2.0", error: { code: -32002, message: APPROVAL_MSG } },
      { jsonrpc: "2.0", error: { code: -32002, message: APPROVAL_MSG } },
      { jsonrpc: "2.0", result: { ok: true } },
    );
    const result = await client.callTool("execute_shell", {}, { approvalTimeoutMs: 60_000 });
    expect(result).toEqual({ ok: true });
  });

  test("sends approval ID header on retry", async () => {
    const headers: string[] = [];
    let i = 0;
    const responses = [
      { jsonrpc: "2.0", error: { code: -32002, message: APPROVAL_MSG } },
      { jsonrpc: "2.0", result: {} },
    ];
    globalThis.fetch = mock((_, init: RequestInit) => {
      headers.push((init.headers as Record<string, string>)?.["X-Cordon-Approval-Id"] ?? "");
      return Promise.resolve({ json: () => Promise.resolve(responses[i++]) });
    });
    await client.callTool("execute_shell", {}, { approvalTimeoutMs: 60_000 });
    expect(headers[0]).toBe("");
    expect(headers[1]).toBe(APPROVAL_ID);
  });

  test("raises ApprovalTimeout when time runs out", async () => {
    globalThis.fetch = mockFetch(
      { jsonrpc: "2.0", error: { code: -32002, message: APPROVAL_MSG } },
      { jsonrpc: "2.0", error: { code: -32002, message: APPROVAL_MSG } },
    );
    await expect(
      client.callTool("execute_shell", {}, { approvalTimeoutMs: 0 }),
    ).rejects.toBeInstanceOf(ApprovalTimeout);
  });

  test("ApprovalTimeout includes approvalId", async () => {
    globalThis.fetch = mockFetch({
      jsonrpc: "2.0",
      error: { code: -32002, message: APPROVAL_MSG },
    });
    const err = (await client
      .callTool("t", {}, { approvalTimeoutMs: 0 })
      .catch((e) => e)) as ApprovalTimeout;
    expect(err.approvalId).toBe(APPROVAL_ID);
  });

  test("raises CordonError on unparseable approval id", async () => {
    globalThis.fetch = mockFetch({
      jsonrpc: "2.0",
      error: { code: -32002, message: "No UUID here." },
    });
    await expect(client.callTool("t", {}, { approvalTimeoutMs: 60_000 })).rejects.toBeInstanceOf(
      CordonError,
    );
  });
});

describe("callTools (parallel)", () => {
  test("returns array of results", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({ json: () => Promise.resolve({ jsonrpc: "2.0", result: { ok: true } }) }),
    );
    const results = await client.callTools([
      { toolName: "a", args: {} },
      { toolName: "b", args: {} },
    ]);
    expect(results).toHaveLength(2);
  });
});
