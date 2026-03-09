import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("../src/config.ts", () => ({
  config: {
    CORDON_WEBHOOK_URL: "http://fake-webhook/hook",
    CORDON_ALERT_ON_BLOCK: true,
    CORDON_ALERT_QUEUE_THRESHOLD: 3,
  },
  oidcEnabled: false,
}));

const { onBlock, onApprovalQueued } = await import("../src/alerting.ts");

// Capture fetch calls
let fetched: { url: string; body: unknown }[] = [];

beforeEach(() => {
  fetched = [];
  globalThis.fetch = vi.fn(async (url, init) => {
    fetched.push({ url: url as string, body: JSON.parse((init as RequestInit).body as string) });
    return new Response("ok");
  });
});

describe("onBlock", () => {
  test("fires fetch when enabled", async () => {
    onBlock("delete_file", "Destructive", "1.2.3.4");
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(1);
  });

  test("posts to webhook URL", async () => {
    onBlock("delete_file", "reason", null);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched[0]?.url).toBe("http://fake-webhook/hook");
  });

  test("payload has text key (Slack compatible)", async () => {
    onBlock("delete_file", "reason", null);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched[0]?.body).toHaveProperty("text");
  });

  test("payload contains tool name", async () => {
    onBlock("execute_shell", "reason", null);
    await new Promise((r) => setTimeout(r, 10));
    expect((fetched[0]?.body as { text: string }).text).toContain("execute_shell");
  });

  test("payload contains reason", async () => {
    onBlock("t", "My specific reason", null);
    await new Promise((r) => setTimeout(r, 10));
    expect((fetched[0]?.body as { text: string }).text).toContain("My specific reason");
  });

  test("payload contains client IP", async () => {
    onBlock("t", "r", "10.0.0.99");
    await new Promise((r) => setTimeout(r, 10));
    expect((fetched[0]?.body as { text: string }).text).toContain("10.0.0.99");
  });

  test("does not fire when ALERT_ON_BLOCK is false", async () => {
    vi.resetModules();
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_WEBHOOK_URL: "http://fake/hook", CORDON_ALERT_ON_BLOCK: false, CORDON_ALERT_QUEUE_THRESHOLD: 3 },
    }));
    const { onBlock: onBlockOff } = await import("../src/alerting.ts");
    onBlockOff("t", "r", null);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(0);
  });

  test("does not fire when no webhook URL", async () => {
    vi.resetModules();
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_WEBHOOK_URL: undefined, CORDON_ALERT_ON_BLOCK: true, CORDON_ALERT_QUEUE_THRESHOLD: 3 },
    }));
    const { onBlock: onBlockOff } = await import("../src/alerting.ts");
    onBlockOff("t", "r", null);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(0);
  });
});

describe("onApprovalQueued", () => {
  test("fires when count meets threshold", async () => {
    onApprovalQueued("execute_shell", 3);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(1);
  });

  test("fires when count exceeds threshold", async () => {
    onApprovalQueued("execute_shell", 10);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(1);
  });

  test("does not fire below threshold", async () => {
    onApprovalQueued("execute_shell", 2);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(0);
  });

  test("payload contains tool name and count", async () => {
    onApprovalQueued("restart_service", 5);
    await new Promise((r) => setTimeout(r, 10));
    const text = (fetched[0]?.body as { text: string }).text;
    expect(text).toContain("restart_service");
    expect(text).toContain("5");
  });

  test("does not fire when threshold is 0", async () => {
    vi.resetModules();
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_WEBHOOK_URL: "http://fake/hook", CORDON_ALERT_ON_BLOCK: true, CORDON_ALERT_QUEUE_THRESHOLD: 0 },
    }));
    const { onApprovalQueued: aq } = await import("../src/alerting.ts");
    aq("t", 999);
    await new Promise((r) => setTimeout(r, 10));
    expect(fetched).toHaveLength(0);
  });
});
