import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';

describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('global limit', () => {
    it('allows calls within the limit', () => {
      const rl = new RateLimiter({ maxCallsPerMinute: 3, onExceeded: 'block' });
      expect(rl.check('db', 'read')).toBe(true);
      expect(rl.check('db', 'read')).toBe(true);
      expect(rl.check('db', 'read')).toBe(true);
    });

    it('blocks when global limit is exceeded', () => {
      const rl = new RateLimiter({ maxCallsPerMinute: 2, onExceeded: 'block' });
      rl.check('db', 'read');
      rl.check('db', 'read');
      expect(rl.check('db', 'read')).toBe(false);
    });

    it('counts across different servers and tools toward global limit', () => {
      const rl = new RateLimiter({ maxCallsPerMinute: 2, onExceeded: 'block' });
      rl.check('db', 'read');
      rl.check('files', 'write');
      expect(rl.check('search', 'query')).toBe(false);
    });
  });

  describe('per-server limit', () => {
    it('enforces server limit independently of other servers', () => {
      const rl = new RateLimiter({
        maxCallsPerMinute: 100,
        perServer: { db: 2 },
        onExceeded: 'block',
      });
      rl.check('db', 'read');
      rl.check('db', 'read');
      expect(rl.check('db', 'read')).toBe(false);
      // different server is unaffected
      expect(rl.check('files', 'read')).toBe(true);
    });

    it('does not apply server limit to servers without a configured limit', () => {
      const rl = new RateLimiter({
        maxCallsPerMinute: 100,
        perServer: { db: 1 },
        onExceeded: 'block',
      });
      expect(rl.check('files', 'read')).toBe(true);
      expect(rl.check('files', 'read')).toBe(true);
    });
  });

  describe('per-tool limit', () => {
    it('enforces tool limit independently of other tools', () => {
      const rl = new RateLimiter({
        maxCallsPerMinute: 100,
        perTool: { drop_table: 1 },
        onExceeded: 'block',
      });
      expect(rl.check('db', 'drop_table')).toBe(true);
      expect(rl.check('db', 'drop_table')).toBe(false);
      // other tools unaffected
      expect(rl.check('db', 'read_data')).toBe(true);
    });

    it('applies per-tool limit across servers', () => {
      const rl = new RateLimiter({
        maxCallsPerMinute: 100,
        perTool: { execute_sql: 1 },
        onExceeded: 'block',
      });
      rl.check('db', 'execute_sql');
      // same tool name on a different server still blocked (tool name is the key)
      expect(rl.check('analytics', 'execute_sql')).toBe(false);
    });
  });

  describe('AND logic — all limits must pass', () => {
    it('blocks when global passes but per-server fails', () => {
      const rl = new RateLimiter({
        maxCallsPerMinute: 100,
        perServer: { db: 1 },
        onExceeded: 'block',
      });
      rl.check('db', 'read');
      expect(rl.check('db', 'read')).toBe(false);
    });

    it('blocks when global passes but per-tool fails', () => {
      const rl = new RateLimiter({
        maxCallsPerMinute: 100,
        perTool: { drop_table: 1 },
        onExceeded: 'block',
      });
      rl.check('db', 'drop_table');
      expect(rl.check('db', 'drop_table')).toBe(false);
    });
  });

  describe('sliding window', () => {
    it('allows calls again after the window expires', () => {
      const rl = new RateLimiter({ maxCallsPerMinute: 2, onExceeded: 'block' });
      rl.check('db', 'read'); // t=0
      rl.check('db', 'read'); // t=0
      expect(rl.check('db', 'read')).toBe(false); // blocked

      vi.advanceTimersByTime(61_000); // slide past the 60s window
      expect(rl.check('db', 'read')).toBe(true);
    });

    it('does not count partial window expiry', () => {
      const rl = new RateLimiter({ maxCallsPerMinute: 2, onExceeded: 'block' });
      rl.check('db', 'read'); // t=0
      vi.advanceTimersByTime(30_000);
      rl.check('db', 'read'); // t=30s — both are still in window
      expect(rl.check('db', 'read')).toBe(false); // blocked at t=30s

      vi.advanceTimersByTime(31_000); // t=61s — first call (t=0) has expired
      expect(rl.check('db', 'read')).toBe(true); // one slot opened
    });
  });

  describe('blocked calls do not consume slots', () => {
    it('does not record a call that was blocked', () => {
      const rl = new RateLimiter({ maxCallsPerMinute: 2, onExceeded: 'block' });
      rl.check('db', 'read'); // recorded
      rl.check('db', 'read'); // recorded
      rl.check('db', 'read'); // blocked — NOT recorded

      vi.advanceTimersByTime(61_000);
      // Window cleared — exactly 2 fresh slots available
      expect(rl.check('db', 'read')).toBe(true);
      expect(rl.check('db', 'read')).toBe(true);
      expect(rl.check('db', 'read')).toBe(false);
    });
  });
});
