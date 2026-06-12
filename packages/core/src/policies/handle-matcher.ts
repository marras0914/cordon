/**
 * Handle-matching — the confidence layer over the temporal call-graph.
 *
 * Cordon's call-graph rules are temporal: they fire on "tool A then tool B"
 * regardless of whether B actually used A's output. That's coarse — it flags
 * read_data → write_file even when the two are unrelated. This module adds a
 * cheap causal signal on top: it extracts opaque handles (UUIDs, ids, file
 * paths, cursor tokens) from one tool's *response* and checks whether a later
 * tool's *arguments* echo any of them. A shared handle means B referenced
 * something A handed back — evidence of an actual data-flow link.
 *
 * It's deliberately not full payload introspection. We never try to understand
 * what the content *means* — we only notice that the same opaque token crossed
 * the boundary. That keeps it content-agnostic (it stays out of the business of
 * interpreting tool data) while recovering most of the causal signal. Per the
 * r/mcp design discussion that motivated this: roughly 60-70% of the causal
 * link at ~10% of the cost of true introspection, and free at the proxy since
 * request/response already flow through here.
 *
 * The base temporal layer stays underneath — it still catches side-effect
 * chains where no handle crosses the boundary (e.g. read_file fills a buffer
 * that write_file later drains). Handle-matching only ever *adds* confidence;
 * it never removes a temporal match unless a rule explicitly opts in via
 * `requireDataFlow`.
 */

// Cap how much of a value we stringify-and-scan per call. Tool responses can be
// large (a file read, a query result); scanning the whole thing on the hot path
// would be wasteful. A shared handle that matters shows up early in practice.
const MAX_SCAN_LENGTH = 64 * 1024;

// Most handles a single value can contribute. Bounds memory against a response
// that is itself a giant list of ids.
const MAX_HANDLES = 256;

// Opaque-handle patterns. Each is deliberately high-entropy / long so that the
// *intersection* of two values rarely matches by coincidence. The shared-handle
// requirement in findSharedHandles is the real noise filter — a token has to
// appear in BOTH the prior response and the current args to count.
const HANDLE_PATTERNS: RegExp[] = [
  // UUID (any version), the most common explicit handle.
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // Long hex token — hashes, record ids, content addresses (>=16 hex chars).
  /\b[0-9a-f]{16,}\b/gi,
  // Unix absolute / temp path with at least two segments (/tmp/x, /var/data/y).
  /(?:\/[A-Za-z0-9_.-]+){2,}\/?/g,
  // Windows absolute path (C:\path\to\file).
  /\b[A-Za-z]:\\(?:[A-Za-z0-9_.-]+\\?)+/g,
  // Base64url-ish cursor / pagination token (>=20 chars). High min length keeps
  // it from matching ordinary words or short ids.
  /\b[A-Za-z0-9_-]{20,}\b/g,
];

function stringify(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    // Circular or otherwise non-serializable — best effort.
    return String(value);
  }
}

/**
 * Extract the set of opaque handles present in a value (a tool response or a
 * tool's arguments). Scans a bounded prefix of the stringified value.
 */
export function extractHandles(value: unknown): Set<string> {
  const text = stringify(value).slice(0, MAX_SCAN_LENGTH);
  const handles = new Set<string>();
  if (!text) return handles;

  for (const pattern of HANDLE_PATTERNS) {
    // Each pattern carries the global flag, so matchAll walks every occurrence.
    for (const match of text.matchAll(pattern)) {
      handles.add(match[0]);
      if (handles.size >= MAX_HANDLES) return handles;
    }
  }
  return handles;
}

/**
 * Return the handles that appear in BOTH the previous tool's emitted handles and
 * the current call's arguments — i.e. the opaque tokens that crossed from A's
 * output into B's input. A non-empty result is evidence of a causal data-flow
 * link between the two calls.
 */
export function findSharedHandles(prevHandles: Set<string>, currentArgs: unknown): string[] {
  if (prevHandles.size === 0) return [];
  const argHandles = extractHandles(currentArgs);
  const shared: string[] = [];
  for (const h of argHandles) {
    if (prevHandles.has(h)) shared.push(h);
  }
  return shared;
}
