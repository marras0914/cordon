/**
 * Non-interactive test that verifies block behavior for drop_table and delete_file.
 * Uses a config with all tools set to 'allow' EXCEPT the blocked ones,
 * so no approval prompt fires and we can verify blocks programmatically.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Write a temp config that uses 'allow' as default (no approval prompts)
// but still blocks drop_table and delete_file
const tempConfig = `
import { defineConfig } from 'cordon-sdk';
import { join } from 'node:path';
export default defineConfig({
  servers: [{
    name: 'demo-db',
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', join(${JSON.stringify(__dirname)}, 'dangerous-server.ts')],
    policy: 'allow',
    tools: {
      drop_table:  { action: 'block', reason: 'Dropping tables is never permitted' },
      delete_file: { action: 'block', reason: 'File deletion requires manual ops' },
    },
  }],
  audit: { enabled: false },
});
`;
const tempConfigPath = join(__dirname, '_test-config.ts');
writeFileSync(tempConfigPath, tempConfig);

const cordonBin = join(__dirname, '../../packages/cli/dist/bin/cordon.js');

const transport = new StdioClientTransport({
  command: 'node',
  args: [cordonBin, 'start', '--config', tempConfigPath],
});

const client = new Client({ name: 'block-test', version: '0.1.0' });
await client.connect(transport);
transport.stderr?.pipe(process.stderr);

const tests = [
  { tool: 'read_data',    args: { table: 'users' },             expectBlocked: false },
  { tool: 'execute_sql',  args: { query: 'SELECT 1' },          expectBlocked: false },
  { tool: 'write_file',   args: { path: '/tmp/x', content: 'y' }, expectBlocked: false },
  { tool: 'drop_table',   args: { table: 'users' },             expectBlocked: true  },
  { tool: 'delete_file',  args: { path: '/etc/passwd' },        expectBlocked: true  },
];

let failures = 0;
for (const t of tests) {
  const result = await client.callTool({ name: t.tool, arguments: t.args });
  const wasBlocked = result.isError === true;
  const pass = wasBlocked === t.expectBlocked;
  const icon = pass ? '✓' : '✗';
  const label = t.expectBlocked ? 'should block' : 'should allow';
  process.stdout.write(`${icon} ${t.tool.padEnd(14)} (${label})\n`);
  if (!pass) failures++;
}

await client.close();

// Clean up temp config
import { unlinkSync } from 'node:fs';
unlinkSync(tempConfigPath);

process.stdout.write(`\n${failures === 0 ? 'All tests passed.' : `${failures} test(s) failed.`}\n`);
process.exit(failures > 0 ? 1 : 0);
