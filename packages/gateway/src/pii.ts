import { config } from "./config.ts";

const PATTERNS: Array<[string, RegExp]> = [
  ["CREDIT_CARD", /\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b/g],
  ["SSN", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["EMAIL", /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g],
  ["PHONE", /(?<!\d)(\+1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}(?!\d)/g],
  ["IPV4", /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g],
];

function redactString(value: string): string {
  let out = value;
  for (const [label, pattern] of PATTERNS) {
    out = out.replace(pattern, `[REDACTED_${label}]`);
  }
  return out;
}

export function redact(value: unknown): unknown {
  if (!config.CORDON_REDACT_PII) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v)]),
    );
  }
  return value;
}
