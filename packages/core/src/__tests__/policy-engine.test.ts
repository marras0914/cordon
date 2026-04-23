import { describe, it, expect } from 'vitest';
import { PolicyEngine } from '../policies/engine.js';
import type { ResolvedConfig } from 'cordon-sdk';

function makeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    servers: [],
    audit: { enabled: false },
    approvals: { channel: 'terminal' },
    ...overrides,
  };
}

describe('PolicyEngine', () => {
  describe('default policy (no config)', () => {
    it('allows any tool when no server policy is configured', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [] }],
      }));
      expect(engine.evaluate('db', 'read_data')).toEqual({ action: 'allow' });
    });
  });

  describe('allow policy', () => {
    it('allows all tools', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [], policy: 'allow' }],
      }));
      expect(engine.evaluate('db', 'drop_table')).toEqual({ action: 'allow' });
    });
  });

  describe('block policy', () => {
    it('blocks all tools', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [], policy: 'block' }],
      }));
      const result = engine.evaluate('db', 'read_data');
      expect(result.action).toBe('block');
    });

    it('uses custom reason from tool-level block config', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{
          name: 'db', transport: 'stdio', command: 'npx', args: [],
          tools: { drop_table: { action: 'block', reason: 'Use a migration script.' } },
        }],
      }));
      const result = engine.evaluate('db', 'drop_table');
      expect(result).toEqual({ action: 'block', reason: 'Use a migration script.' });
    });
  });

  describe('approve policy', () => {
    it('requires approval for all tools', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [], policy: 'approve' }],
      }));
      expect(engine.evaluate('db', 'read_data')).toEqual({ action: 'approve' });
    });
  });

  describe('approve-writes policy', () => {
    const engine = new PolicyEngine(makeConfig({
      servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [], policy: 'approve-writes' }],
    }));

    it('allows reads', () => {
      expect(engine.evaluate('db', 'read_data')).toEqual({ action: 'allow' });
      expect(engine.evaluate('db', 'get_user')).toEqual({ action: 'allow' });
      expect(engine.evaluate('db', 'list_tables')).toEqual({ action: 'allow' });
      expect(engine.evaluate('db', 'fetch_records')).toEqual({ action: 'allow' });
    });

    it('requires approval for write-prefixed tools', () => {
      expect(engine.evaluate('db', 'write_file')).toEqual({ action: 'approve' });
      expect(engine.evaluate('db', 'create_user')).toEqual({ action: 'approve' });
      expect(engine.evaluate('db', 'delete_record')).toEqual({ action: 'approve' });
      expect(engine.evaluate('db', 'update_config')).toEqual({ action: 'approve' });
      expect(engine.evaluate('db', 'drop_table')).toEqual({ action: 'approve' });
      expect(engine.evaluate('db', 'execute_sql')).toEqual({ action: 'approve' });
      expect(engine.evaluate('db', 'insert_row')).toEqual({ action: 'approve' });
    });

    it('requires approval for exact prefix match', () => {
      expect(engine.evaluate('db', 'write')).toEqual({ action: 'approve' });
      expect(engine.evaluate('db', 'delete')).toEqual({ action: 'approve' });
    });

    it('allows tools that start with a write word but have no separator', () => {
      // "writer" is NOT a write operation — no underscore/hyphen separator
      expect(engine.evaluate('db', 'writer_notes')).toEqual({ action: 'allow' });
      expect(engine.evaluate('db', 'creator_id')).toEqual({ action: 'allow' });
    });
  });

  describe('read-only policy', () => {
    const engine = new PolicyEngine(makeConfig({
      servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [], policy: 'read-only' }],
    }));

    it('allows reads', () => {
      expect(engine.evaluate('db', 'read_data')).toEqual({ action: 'allow' });
    });

    it('blocks writes', () => {
      const result = engine.evaluate('db', 'write_file');
      expect(result.action).toBe('block');
    });
  });

  describe('log-only policy', () => {
    it('allows all tools', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [], policy: 'log-only' }],
      }));
      expect(engine.evaluate('db', 'drop_table')).toEqual({ action: 'allow' });
    });
  });

  describe('policy precedence', () => {
    it('tool-level policy overrides server-level policy', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{
          name: 'db', transport: 'stdio', command: 'npx', args: [],
          policy: 'approve-writes',
          tools: {
            drop_table: { action: 'block', reason: 'Never.' },
            read_data: 'approve',
          },
        }],
      }));

      // Tool-level block overrides server approve-writes
      expect(engine.evaluate('db', 'drop_table')).toEqual({ action: 'block', reason: 'Never.' });
      // Tool-level approve overrides server approve-writes (which would allow reads)
      expect(engine.evaluate('db', 'read_data')).toEqual({ action: 'approve' });
      // Unspecified write tool falls back to server policy
      expect(engine.evaluate('db', 'write_file')).toEqual({ action: 'approve' });
      // Unspecified read tool falls back to server policy
      expect(engine.evaluate('db', 'get_user')).toEqual({ action: 'allow' });
    });

    it('unknown server defaults to allow', () => {
      const engine = new PolicyEngine(makeConfig({ servers: [] }));
      expect(engine.evaluate('unknown_server', 'any_tool')).toEqual({ action: 'allow' });
    });
  });

  describe('multi-server isolation', () => {
    it('applies policies per server', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [
          { name: 'safe', transport: 'stdio', command: 'npx', args: [], policy: 'allow' },
          { name: 'strict', transport: 'stdio', command: 'npx', args: [], policy: 'block' },
        ],
      }));
      expect(engine.evaluate('safe', 'drop_table')).toEqual({ action: 'allow' });
      expect(engine.evaluate('strict', 'read_data').action).toBe('block');
    });
  });

  describe('hidden policy', () => {
    it('isHidden returns true for server-level hidden policy', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'secret', transport: 'stdio', command: 'npx', args: [], policy: 'hidden' }],
      }));
      expect(engine.isHidden('secret', 'any_tool')).toBe(true);
    });

    it('isHidden returns false for non-hidden policies', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'open', transport: 'stdio', command: 'npx', args: [], policy: 'allow' }],
      }));
      expect(engine.isHidden('open', 'any_tool')).toBe(false);
    });

    it('isHidden returns true for tool-level hidden overriding server allow', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{
          name: 'db', transport: 'stdio', command: 'npx', args: [],
          policy: 'allow',
          tools: { drop_table: 'hidden' },
        }],
      }));
      expect(engine.isHidden('db', 'drop_table')).toBe(true);
      expect(engine.isHidden('db', 'read_data')).toBe(false);
    });

    it('isHidden returns false for tool-level allow overriding server hidden', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{
          name: 'db', transport: 'stdio', command: 'npx', args: [],
          policy: 'hidden',
          tools: { safe_tool: 'allow' },
        }],
      }));
      expect(engine.isHidden('db', 'safe_tool')).toBe(false);
      expect(engine.isHidden('db', 'secret_tool')).toBe(true);
    });

    it('evaluate() blocks hidden tools as a failsafe', () => {
      // Gateway filters hidden tools out of tools/list, but if a client
      // somehow knows a hidden tool's name and calls it, the engine should
      // still reject rather than forward the call.
      const engine = new PolicyEngine(makeConfig({
        servers: [{ name: 'db', transport: 'stdio', command: 'npx', args: [], policy: 'hidden' }],
      }));
      const result = engine.evaluate('db', 'any_tool');
      expect(result.action).toBe('block');
      if (result.action === 'block') {
        expect(result.reason).toContain('hidden');
      }
    });

    it('evaluate() uses custom reason from tool-level hidden config', () => {
      const engine = new PolicyEngine(makeConfig({
        servers: [{
          name: 'db', transport: 'stdio', command: 'npx', args: [],
          tools: { drop_table: { action: 'hidden', reason: 'Internal tool, never exposed.' } },
        }],
      }));
      const result = engine.evaluate('db', 'drop_table');
      expect(result).toEqual({
        action: 'block',
        reason: 'Internal tool, never exposed.',
      });
    });
  });
});
