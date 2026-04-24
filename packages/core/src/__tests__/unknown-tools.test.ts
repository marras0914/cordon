import { describe, it, expect } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { StdioServerConfig } from 'cordon-sdk';
import { filterUnknownTools } from '../proxy/upstream-manager.js';

function tool(name: string): Tool {
  return { name, description: `${name} description`, inputSchema: { type: 'object' } };
}

function makeConfig(overrides: Partial<StdioServerConfig> = {}): StdioServerConfig {
  return {
    name: 'db',
    transport: 'stdio',
    command: 'npx',
    args: [],
    ...overrides,
  };
}

describe('filterUnknownTools', () => {
  describe('feature off (no knownTools set)', () => {
    it('passes every tool through unchanged when knownTools is undefined', () => {
      const tools = [tool('query'), tool('drop_table'), tool('anything_goes')];
      const cfg = makeConfig();
      const result = filterUnknownTools(tools, cfg);

      expect(result.included).toEqual(tools);
      expect(result.blocked).toEqual([]);
      expect(result.allowedWithWarning).toEqual([]);
    });

    it('is still inert even if onUnknownTool is set (knownTools is the activation switch)', () => {
      const tools = [tool('query'), tool('drop_table')];
      const cfg = makeConfig({ onUnknownTool: 'block' });
      const result = filterUnknownTools(tools, cfg);

      // No knownTools means feature off — all tools pass
      expect(result.included).toEqual(tools);
      expect(result.blocked).toEqual([]);
    });
  });

  describe('feature on, onUnknownTool: block (default)', () => {
    it('blocks tools not in knownTools', () => {
      const tools = [tool('query'), tool('drop_table'), tool('truncate')];
      const cfg = makeConfig({ knownTools: ['query'] });
      const result = filterUnknownTools(tools, cfg);

      expect(result.included).toEqual([tools[0]]);
      expect(result.blocked.map((t) => t.name)).toEqual(['drop_table', 'truncate']);
      expect(result.allowedWithWarning).toEqual([]);
    });

    it('treats tools keyed in `tools` map as known even without knownTools entry', () => {
      // Operator wrote { drop_table: 'block' } — that's explicit knowledge of the tool
      const tools = [tool('query'), tool('drop_table'), tool('secret')];
      const cfg = makeConfig({
        knownTools: ['query'],
        tools: { drop_table: 'block' },
      });
      const result = filterUnknownTools(tools, cfg);

      expect(result.included.map((t) => t.name)).toEqual(['query', 'drop_table']);
      expect(result.blocked.map((t) => t.name)).toEqual(['secret']);
    });

    it('empty knownTools with no tools map blocks everything', () => {
      const tools = [tool('query'), tool('anything')];
      const cfg = makeConfig({ knownTools: [] });
      const result = filterUnknownTools(tools, cfg);

      expect(result.included).toEqual([]);
      expect(result.blocked.map((t) => t.name)).toEqual(['query', 'anything']);
    });
  });

  describe('feature on, onUnknownTool: allow', () => {
    it('includes unknown tools but flags them for warning', () => {
      const tools = [tool('query'), tool('new_tool')];
      const cfg = makeConfig({
        knownTools: ['query'],
        onUnknownTool: 'allow',
      });
      const result = filterUnknownTools(tools, cfg);

      expect(result.included.map((t) => t.name)).toEqual(['query', 'new_tool']);
      expect(result.blocked).toEqual([]);
      expect(result.allowedWithWarning.map((t) => t.name)).toEqual(['new_tool']);
    });

    it('does not flag known tools as allowed-with-warning', () => {
      const tools = [tool('query'), tool('list_tables')];
      const cfg = makeConfig({
        knownTools: ['query', 'list_tables'],
        onUnknownTool: 'allow',
      });
      const result = filterUnknownTools(tools, cfg);

      expect(result.included).toEqual(tools);
      expect(result.allowedWithWarning).toEqual([]);
    });
  });

  describe('real-world scenarios', () => {
    it('Postgres MCP: operator declares query is known, server adds truncate next release → blocked', () => {
      // First Cordon run captured these
      const cfg = makeConfig({
        name: 'postgres',
        knownTools: ['query'],
        policy: 'read-only',
      });
      // Simulate what upstream advertises after a server update
      const tools = [tool('query'), tool('truncate_table'), tool('execute_admin_sql')];
      const result = filterUnknownTools(tools, cfg);

      expect(result.included.map((t) => t.name)).toEqual(['query']);
      expect(result.blocked.map((t) => t.name)).toEqual(['truncate_table', 'execute_admin_sql']);
    });

    it('GitHub MCP: operator has tool-level policies, new tool next release blocks without config change', () => {
      const cfg = makeConfig({
        name: 'github',
        knownTools: ['get_issue', 'list_repos', 'create_pull_request'],
        tools: {
          create_pull_request: 'approve',
          delete_repository: 'block',  // operator knows about this risk
        },
      });
      // delete_repository should NOT be flagged as unknown — it's in tools map
      // malicious_new_tool should be blocked
      const tools = [
        tool('get_issue'),
        tool('list_repos'),
        tool('create_pull_request'),
        tool('delete_repository'),
        tool('malicious_new_tool'),
      ];
      const result = filterUnknownTools(tools, cfg);

      expect(result.included.map((t) => t.name)).toEqual([
        'get_issue',
        'list_repos',
        'create_pull_request',
        'delete_repository',
      ]);
      expect(result.blocked.map((t) => t.name)).toEqual(['malicious_new_tool']);
    });
  });
});
