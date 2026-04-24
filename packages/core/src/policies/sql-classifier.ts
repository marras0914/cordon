import { Parser } from 'node-sql-parser';

/**
 * Classification of a SQL string for policy enforcement.
 *
 * - `'read'`: all statements are SELECTs (including `WITH ... SELECT` CTEs)
 * - `'write'`: at least one statement is not a SELECT (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/CALL/...)
 * - `'unknown'`: parse failure, empty input, or otherwise unclassifiable
 *
 * Classifier is fail-closed: unparseable SQL returns `'unknown'`, and
 * calling code should treat `'unknown'` the same as `'write'` for blocking
 * decisions. A crafted malformed string must never become a bypass.
 */
export type SqlClassification = 'read' | 'write' | 'unknown';

const parser = new Parser();

/** Statement types we consider pure reads. Extend cautiously. */
const READ_STATEMENT_TYPES = new Set<string>([
  'select',
  'show', // SHOW TABLES / SHOW DATABASES / SHOW search_path etc. — introspection
]);

/**
 * Matches a leading `EXPLAIN ` keyword (case-insensitive) that is NOT
 * followed by `ANALYZE`. EXPLAIN by itself describes the query plan
 * without executing it — safe. EXPLAIN ANALYZE actually runs the query,
 * so we leave that as-is (parser will fail → unknown → block).
 */
const LEADING_EXPLAIN_NONANALYZE = /^\s*explain\s+(?!analyze\b)/i;

/**
 * Classify a SQL string as a read, write, or unparseable.
 *
 * Multi-statement input like "SELECT 1; DROP TABLE users;" is classified
 * as `'write'` if any statement is non-SELECT. The parser also handles
 * comments, whitespace, and string literals correctly — regex-based
 * classifiers get fooled by tricks such as a block-comment enclosing the
 * SELECT keyword before a destructive statement.
 *
 * Read-type support: `SELECT`, `WITH ... SELECT` (CTE), `SHOW`, and a
 * leading bare `EXPLAIN ` (not `EXPLAIN ANALYZE`) which is stripped
 * before re-classifying the underlying statement. Other read-ish
 * statements (`DESCRIBE`, `PRAGMA`, standalone `VALUES`, `EXPLAIN ANALYZE`)
 * don't parse in PostgreSQL mode and fall through to `'unknown'`
 * (fail-closed — blocked under sql-read-only).
 *
 * @param sql - the raw SQL text
 * @param dialect - sql dialect (defaults to `'postgresql'`). See
 *   node-sql-parser's supported list for other values.
 */
export function classifySql(sql: string, dialect = 'postgresql'): SqlClassification {
  if (typeof sql !== 'string') return 'unknown';
  const trimmed = sql.trim();
  if (trimmed.length === 0) return 'unknown';

  // Pre-normalize: strip a leading bare EXPLAIN so `EXPLAIN SELECT ...`
  // classifies the same as `SELECT ...`. `EXPLAIN ANALYZE ...` is NOT
  // stripped — ANALYZE actually executes the underlying statement, so we
  // want that to fall through to raw parsing (which fails, returning
  // 'unknown' → blocked under sql-read-only). The regex is anchored at
  // start-of-string and runs AFTER trim, so a comment-prefixed attack like
  // `/* EXPLAIN */ DELETE` doesn't match here.
  if (LEADING_EXPLAIN_NONANALYZE.test(trimmed)) {
    return classifySql(trimmed.replace(LEADING_EXPLAIN_NONANALYZE, ''), dialect);
  }

  let ast: unknown;
  try {
    ast = parser.astify(trimmed, { database: dialect });
  } catch {
    return 'unknown';
  }

  // astify returns either a single AST node (one statement) or an array
  // (multiple semicolon-separated statements). Normalize to array.
  const statements = Array.isArray(ast) ? ast : [ast];

  if (statements.length === 0) return 'unknown';

  for (const stmt of statements) {
    if (!stmt || typeof stmt !== 'object') return 'unknown';
    const type = (stmt as { type?: unknown }).type;
    if (typeof type !== 'string' || !READ_STATEMENT_TYPES.has(type)) {
      // Any non-read statement in the set classifies the whole thing as write.
      // `WITH x AS (...) SELECT ...` parses as type='select' so CTEs are
      // correctly classified as reads.
      return 'write';
    }
  }

  return 'read';
}
