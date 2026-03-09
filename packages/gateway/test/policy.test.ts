import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../src/config.ts", () => ({
  config: {
    CORDON_OPA_URL: undefined,
    REAL_MCP_SERVER: "http://localhost:8001",
  },
  oidcEnabled: false,
}));

// Mock filesystem reads
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(
    () => `
version: "1.0"
default_action: ALLOW
rules:
  - tool: delete_file
    action: BLOCK
    reason: Destructive operations restricted.
  - tool: execute_shell
    action: REQUIRE_APPROVAL
    reason: Shell commands require oversight.
`,
  ),
  writeFileSync: vi.fn(),
}));

const { evaluatePolicy } = await import("../src/policy.ts");

describe("YAML policy", () => {
  test("returns BLOCK for blocked tool", async () => {
    const result = await evaluatePolicy("delete_file", {});
    expect(result.action).toBe("BLOCK");
    expect(result.reason).toContain("Destructive");
  });

  test("returns REQUIRE_APPROVAL for gated tool", async () => {
    const result = await evaluatePolicy("execute_shell", {});
    expect(result.action).toBe("REQUIRE_APPROVAL");
  });

  test("returns ALLOW for unknown tool (default)", async () => {
    const result = await evaluatePolicy("read_file", {});
    expect(result.action).toBe("ALLOW");
  });

  test("reason is empty string for ALLOW", async () => {
    const result = await evaluatePolicy("read_file", {});
    expect(result.reason).toBe("");
  });
});

describe("OPA policy", () => {
  beforeEach(() => vi.resetModules());

  test("uses OPA result when available", async () => {
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_OPA_URL: "http://opa:8181" },
      oidcEnabled: false,
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => "version: '1.0'\ndefault_action: ALLOW\nrules: []"),
    }));
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: { action: "BLOCK", reason: "OPA said no" } })),
    );
    const { evaluatePolicy: evalOpa } = await import("../src/policy.ts");
    const result = await evalOpa("any_tool", {});
    expect(result.action).toBe("BLOCK");
    expect(result.reason).toBe("OPA said no");
  });

  test("falls back to YAML when OPA times out", async () => {
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_OPA_URL: "http://opa:8181" },
      oidcEnabled: false,
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => "version: '1.0'\ndefault_action: ALLOW\nrules: []"),
    }));
    globalThis.fetch = vi.fn(async () => {
      throw new Error("timeout");
    });
    const { evaluatePolicy: evalFallback } = await import("../src/policy.ts");
    const result = await evalFallback("read_file", {});
    expect(result.action).toBe("ALLOW");
  });

  test("passes tool name and arguments to OPA", async () => {
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_OPA_URL: "http://opa:8181" },
      oidcEnabled: false,
    }));
    vi.doMock("node:fs", () => ({
      readFileSync: vi.fn(() => "version: '1.0'\ndefault_action: ALLOW\nrules: []"),
    }));
    let captured: unknown;
    globalThis.fetch = vi.fn(async (_, init) => {
      captured = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ result: { action: "ALLOW", reason: "" } }));
    });
    const { evaluatePolicy: evalCapture } = await import("../src/policy.ts");
    await evalCapture("run_query", { table: "SCADA_RTU" }, "10.0.0.1");
    const input = (captured as { input: unknown }).input as Record<string, unknown>;
    expect(input.tool).toBe("run_query");
    expect((input.arguments as Record<string, unknown>).table).toBe("SCADA_RTU");
    expect(input.client_ip).toBe("10.0.0.1");
  });
});
