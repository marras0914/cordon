import { describe, expect, test } from "vitest";
import { vi } from "vitest";

// Force PII on for all tests
vi.mock("../src/config.ts", () => ({
  config: {
    CORDON_REDACT_PII: true,
    CORDON_RATE_LIMIT: 60,
    CORDON_RATE_WINDOW: 60,
    CORDON_WEBHOOK_URL: undefined,
    CORDON_ALERT_ON_BLOCK: true,
    CORDON_ALERT_QUEUE_THRESHOLD: 5,
    CORDON_DASHBOARD_KEY: "",
    CORDON_SESSION_SECRET: "test-secret-32-chars-padded-here",
    CORDON_OPA_URL: undefined,
    REAL_MCP_SERVER: "http://localhost:8001",
    PORT: 8000,
    CORDON_DB: ":memory:",
  },
  oidcEnabled: false,
}));

const { redact } = await import("../src/pii.ts");

describe("PII redaction — strings", () => {
  test("redacts email", () => {
    expect(redact("contact user@example.com now")).toContain("[REDACTED_EMAIL]");
  });

  test("redacts SSN", () => {
    expect(redact("ssn 123-45-6789 here")).toContain("[REDACTED_SSN]");
  });

  test("redacts credit card", () => {
    expect(redact("card 4111 1111 1111 1111 ok")).toContain("[REDACTED_CREDIT_CARD]");
  });

  test("redacts phone (US format)", () => {
    expect(redact("call 555-867-5309")).toContain("[REDACTED_PHONE]");
  });

  test("redacts phone with +1 prefix", () => {
    expect(redact("+1 555-867-5309")).toContain("[REDACTED_PHONE]");
  });

  test("redacts IPv4", () => {
    expect(redact("host 192.168.1.100 is up")).toContain("[REDACTED_IPV4]");
  });

  test("passes through clean strings", () => {
    expect(redact("hello world")).toBe("hello world");
  });
});

describe("PII redaction — objects", () => {
  test("redacts nested string values", () => {
    const result = redact({ user: "admin@corp.com", note: "safe" }) as Record<string, unknown>;
    expect(result.user).toContain("[REDACTED_EMAIL]");
    expect(result.note).toBe("safe");
  });

  test("redacts deeply nested values", () => {
    const result = redact({ a: { b: { c: "123-45-6789" } } }) as Record<string, unknown>;
    const inner = (result.a as Record<string, unknown>).b as Record<string, unknown>;
    expect(inner.c).toContain("[REDACTED_SSN]");
  });

  test("preserves non-string values", () => {
    const result = redact({ count: 42, flag: true }) as Record<string, unknown>;
    expect(result.count).toBe(42);
    expect(result.flag).toBe(true);
  });
});

describe("PII redaction — arrays", () => {
  test("redacts strings in arrays", () => {
    const result = redact(["user@example.com", "safe"]) as string[];
    expect(result[0]).toContain("[REDACTED_EMAIL]");
    expect(result[1]).toBe("safe");
  });

  test("handles mixed arrays", () => {
    const result = redact([1, "test@x.com", null]) as unknown[];
    expect(result[0]).toBe(1);
    expect(result[1] as string).toContain("[REDACTED_EMAIL]");
    expect(result[2]).toBe(null);
  });
});

describe("PII disabled", () => {
  test("passes through when disabled", async () => {
    vi.resetModules();
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_REDACT_PII: false },
      oidcEnabled: false,
    }));
    const { redact: redactOff } = await import("../src/pii.ts");
    expect(redactOff("user@example.com")).toBe("user@example.com");
  });
});
