import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuditLogger } from '../audit/logger.js';

describe('AuditLogger', () => {
  describe('disabled', () => {
    it('produces no output when audit is disabled', () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const logger = new AuditLogger({ enabled: false });
      logger.log({ event: 'gateway_started', servers: ['db'] });
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    });

    it('produces no output when audit config is undefined', () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const logger = new AuditLogger(undefined);
      logger.log({ event: 'gateway_started', servers: ['db'] });
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    });
  });

  describe('stdout output', () => {
    let write: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      write.mockRestore();
    });

    it('writes a JSON line to stderr', () => {
      const logger = new AuditLogger({ enabled: true, output: 'stdout' });
      logger.log({ event: 'gateway_started', servers: ['db'] });

      expect(write).toHaveBeenCalledOnce();
      const line = String((write.mock.calls[0] as [string])[0]);
      const parsed = JSON.parse(line.trim());
      expect(parsed.event).toBe('gateway_started');
      expect(parsed.servers).toEqual(['db']);
    });

    it('adds a timestamp to every entry', () => {
      const before = Date.now();
      const logger = new AuditLogger({ enabled: true, output: 'stdout' });
      logger.log({ event: 'gateway_started', servers: [] });
      const after = Date.now();

      const line = String((write.mock.calls[0] as [string])[0]);
      const parsed = JSON.parse(line.trim());
      expect(parsed.timestamp).toBeGreaterThanOrEqual(before);
      expect(parsed.timestamp).toBeLessThanOrEqual(after);
    });

    it('writes all fields passed in', () => {
      const logger = new AuditLogger({ enabled: true, output: 'stdout' });
      logger.log({
        event: 'tool_call_blocked',
        callId: 'abc-123',
        serverName: 'db',
        toolName: 'drop_table',
        reason: 'blocked by policy',
      });

      const line = String((write.mock.calls[0] as [string])[0]);
      const parsed = JSON.parse(line.trim());
      expect(parsed.callId).toBe('abc-123');
      expect(parsed.serverName).toBe('db');
      expect(parsed.toolName).toBe('drop_table');
      expect(parsed.reason).toBe('blocked by policy');
    });

    it('writes to both outputs when configured with array', () => {
      const logger = new AuditLogger({ enabled: true, output: ['stdout', 'stdout'] });
      logger.log({ event: 'gateway_started', servers: [] });
      expect(write).toHaveBeenCalledTimes(2);
    });
  });

  describe('close', () => {
    it('does not throw when closed with no outputs', () => {
      const logger = new AuditLogger({ enabled: false });
      expect(() => logger.close()).not.toThrow();
    });

    it('does not throw when closed with stdout output', () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const logger = new AuditLogger({ enabled: true, output: 'stdout' });
      expect(() => logger.close()).not.toThrow();
      vi.restoreAllMocks();
    });
  });
});
