import { describe, it, expect } from 'vitest';
import { classifySql } from '../policies/sql-classifier.js';

describe('classifySql', () => {
  describe('read queries', () => {
    it('classifies a basic SELECT as read', () => {
      expect(classifySql('SELECT 1')).toBe('read');
    });

    it('classifies a SELECT with joins as read', () => {
      expect(
        classifySql(`
          SELECT u.name, o.total
          FROM users u
          JOIN orders o ON o.user_id = u.id
          WHERE u.created_at > NOW() - INTERVAL '30 days'
        `),
      ).toBe('read');
    });

    it('classifies a WITH CTE wrapping a SELECT as read', () => {
      expect(
        classifySql(`
          WITH active_users AS (
            SELECT id FROM users WHERE last_login > NOW() - INTERVAL '7 days'
          )
          SELECT * FROM active_users
        `),
      ).toBe('read');
    });

    it('classifies multiple SELECTs in one input as read', () => {
      expect(classifySql('SELECT 1; SELECT 2;')).toBe('read');
    });

    it('ignores leading whitespace and trailing semicolons', () => {
      expect(classifySql('   SELECT * FROM users;   ')).toBe('read');
    });

    it('handles SQL with line comments preserved', () => {
      expect(
        classifySql(`
          -- This is a comment
          SELECT id FROM users
        `),
      ).toBe('read');
    });

    it('classifies SHOW TABLES as read (introspection)', () => {
      expect(classifySql('SHOW TABLES')).toBe('read');
    });

    it('classifies SHOW search_path as read', () => {
      expect(classifySql('SHOW search_path')).toBe('read');
    });

    it('strips leading EXPLAIN and classifies the underlying statement (EXPLAIN SELECT → read)', () => {
      expect(classifySql('EXPLAIN SELECT * FROM users')).toBe('read');
    });

    it('handles EXPLAIN case-insensitively', () => {
      expect(classifySql('explain SELECT 1')).toBe('read');
    });
  });

  describe('write queries — DML', () => {
    it('classifies INSERT as write', () => {
      expect(classifySql("INSERT INTO users (name) VALUES ('alice')")).toBe('write');
    });

    it('classifies UPDATE as write', () => {
      expect(classifySql("UPDATE users SET name = 'bob' WHERE id = 1")).toBe('write');
    });

    it('classifies DELETE as write', () => {
      expect(classifySql('DELETE FROM sessions WHERE expires_at < NOW()')).toBe('write');
    });

    it('WITH ... DELETE is not classified as read (CTE-wrapped destructive never reaches "allow")', () => {
      // node-sql-parser doesn't currently support CTE-wrapped DELETE syntax
      // in postgresql mode; the parser throws and the classifier falls to
      // `'unknown'`. The safety invariant is that this statement must NEVER
      // classify as `'read'` — whether it lands on write or unknown, policy
      // enforcement will block or require approval.
      const result = classifySql(`
        WITH stale AS (SELECT id FROM sessions WHERE expires_at < NOW())
        DELETE FROM sessions USING stale WHERE sessions.id = stale.id
      `);
      expect(result).not.toBe('read');
    });
  });

  describe('write queries — DDL', () => {
    it('classifies DROP TABLE as write', () => {
      expect(classifySql('DROP TABLE users')).toBe('write');
    });

    it('classifies CREATE TABLE as write', () => {
      expect(classifySql('CREATE TABLE foo (id INT)')).toBe('write');
    });

    it('classifies ALTER TABLE as write', () => {
      expect(classifySql('ALTER TABLE users ADD COLUMN email TEXT')).toBe('write');
    });

    it('classifies TRUNCATE as write', () => {
      expect(classifySql('TRUNCATE TABLE audit_log')).toBe('write');
    });
  });

  describe('multi-statement — prompt injection pattern', () => {
    it('classifies SELECT + DELETE as write (the classic injection)', () => {
      // This is the exact pattern the post body warns about:
      // agent thinks it's doing a read, actual text is mixed.
      expect(classifySql('SELECT 1; DROP TABLE users;')).toBe('write');
    });

    it('classifies DELETE + SELECT as write (any non-read member)', () => {
      expect(classifySql('DELETE FROM foo; SELECT 1;')).toBe('write');
    });

    it('block-comment wrapping SELECT does not fool the classifier', () => {
      // Regex-based classifiers see "SELECT" first and fail open.
      // The AST parser sees the real statement type.
      expect(classifySql('/* SELECT */ DELETE FROM users')).toBe('write');
    });

    it('EXPLAIN strip is anchored at start — /* EXPLAIN */ DELETE stays write', () => {
      // The leading-EXPLAIN pre-normalization regex is anchored to
      // start-of-string after trim. A comment-prefixed EXPLAIN doesn't
      // match, so the parser sees the real DELETE and classifies as write.
      expect(classifySql('/* EXPLAIN */ DELETE FROM users')).toBe('write');
    });

    it('EXPLAIN DELETE still classifies as write (EXPLAIN strips, DELETE remains)', () => {
      expect(classifySql('EXPLAIN DELETE FROM users WHERE id = 1')).toBe('write');
    });
  });

  describe('unparseable / edge cases', () => {
    it('returns unknown for empty string', () => {
      expect(classifySql('')).toBe('unknown');
    });

    it('returns unknown for whitespace only', () => {
      expect(classifySql('   \n\t  ')).toBe('unknown');
    });

    it('returns unknown for malformed SQL', () => {
      expect(classifySql('SELEKT * FROMM users')).toBe('unknown');
    });

    it('returns unknown for non-SQL text', () => {
      expect(classifySql("this isn't SQL, it's just a sentence")).toBe('unknown');
    });

    it('returns unknown for non-string input coerced through', () => {
      // @ts-expect-error — deliberately passing wrong type
      expect(classifySql(null)).toBe('unknown');
      // @ts-expect-error
      expect(classifySql(undefined)).toBe('unknown');
      // @ts-expect-error
      expect(classifySql(42)).toBe('unknown');
    });

    it('EXPLAIN ANALYZE is NOT stripped — ANALYZE executes the query', () => {
      // EXPLAIN ANALYZE SELECT actually runs the query. We deliberately
      // let this fall through to raw parsing (which fails) so it classifies
      // as 'unknown' → fail-closed → blocked under sql-read-only. Do not
      // optimize this into a read even though the underlying is SELECT.
      expect(classifySql('EXPLAIN ANALYZE SELECT * FROM users')).not.toBe('read');
      expect(classifySql('EXPLAIN ANALYZE DELETE FROM users WHERE id = 1')).not.toBe('read');
    });

    it('DESCRIBE / standalone VALUES / PRAGMA fall through to unknown (parser limitation)', () => {
      // These are legitimate reads in their respective dialects but
      // node-sql-parser in PostgreSQL mode doesn't parse them. Document
      // the behavior: they classify as unknown, which means sql-read-only
      // blocks them. Users affected should switch to sql-approve-writes
      // or add a tool-level override.
      expect(classifySql('DESCRIBE users')).toBe('unknown');
      expect(classifySql('VALUES (1, 2, 3)')).toBe('unknown');
      expect(classifySql('PRAGMA foreign_keys = ON')).toBe('unknown');
    });
  });
});
