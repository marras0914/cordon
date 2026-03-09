import { describe, test, expect, beforeEach } from "vitest";
import { vi } from "vitest";

vi.mock("../src/config.ts", () => ({
  config: {
    CORDON_RATE_LIMIT: 3,
    CORDON_RATE_WINDOW: 60,
  },
  oidcEnabled: false,
}));

const { check, reset } = await import("../src/rate-limit.ts");

beforeEach(() => reset());

describe("rate limiting — basic", () => {
  test("first call is allowed", () => {
    const { allowed } = check("1.2.3.4");
    expect(allowed).toBe(true);
  });

  test("calls within limit are allowed", () => {
    check("1.2.3.4");
    check("1.2.3.4");
    const { allowed } = check("1.2.3.4");
    expect(allowed).toBe(true);
  });

  test("call exceeding limit is denied", () => {
    check("1.2.3.4");
    check("1.2.3.4");
    check("1.2.3.4");
    const { allowed, retryAfter } = check("1.2.3.4");
    expect(allowed).toBe(false);
    expect(retryAfter).toBeGreaterThan(0);
  });

  test("retryAfter is a positive integer", () => {
    for (let i = 0; i < 4; i++) check("10.0.0.1");
    const { retryAfter } = check("10.0.0.1");
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});

describe("rate limiting — per IP", () => {
  test("different IPs are tracked independently", () => {
    check("1.1.1.1");
    check("1.1.1.1");
    check("1.1.1.1"); // at limit
    check("1.1.1.1"); // over limit

    const { allowed } = check("2.2.2.2"); // fresh IP
    expect(allowed).toBe(true);
  });
});

describe("rate limiting — disabled", () => {
  test("allows all calls when limit is 0", async () => {
    vi.resetModules();
    vi.doMock("../src/config.ts", () => ({
      config: { CORDON_RATE_LIMIT: 0, CORDON_RATE_WINDOW: 60 },
      oidcEnabled: false,
    }));
    const { check: checkOff } = await import("../src/rate-limit.ts");
    for (let i = 0; i < 200; i++) {
      const { allowed } = checkOff("5.5.5.5");
      expect(allowed).toBe(true);
    }
  });
});

describe("rate limiting — reset", () => {
  test("reset single IP clears its bucket", () => {
    check("9.9.9.9");
    check("9.9.9.9");
    check("9.9.9.9"); // at limit
    reset("9.9.9.9");
    const { allowed } = check("9.9.9.9");
    expect(allowed).toBe(true);
  });

  test("reset all clears every bucket", () => {
    check("3.3.3.3");
    check("4.4.4.4");
    check("5.5.5.5");
    reset();
    for (const ip of ["3.3.3.3", "4.4.4.4", "5.5.5.5"]) {
      expect(check(ip).allowed).toBe(true);
    }
  });
});
