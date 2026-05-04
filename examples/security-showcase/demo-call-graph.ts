/**
 * 30-second screencast demo. Shows:
 *   1. Agent reads database (allowed)
 *   2. Agent attempts to write to disk (blocked by call-graph rule —
 *      not because write_file is forbidden, but because the *sequence*
 *      read_data → write_file matches an exfil pattern).
 *
 * Run inside examples/security-showcase:
 *   npx tsx demo-call-graph.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal config that allows everything except the read→write chain.
const tempConfig = `
import { defineConfig } from '@getcordon/policy';
import { join } from 'node:path';
export default defineConfig({
  agentId: 'demo-agent',
  servers: [{
    name: 'demo-db',
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', join(${JSON.stringify(__dirname)}, 'dangerous-server.ts')],
    policy: 'allow',
  }],
  callGraph: [
    { from: 'read_data', to: 'write_file', action: 'block',
      reason: 'No file writes after database reads — exfil-shaped.' },
  ],
  audit: { enabled: false },
});
`;
const tempConfigPath = join(__dirname, '_demo-config.ts');
writeFileSync(tempConfigPath, tempConfig);

const cordonBin = join(__dirname, '../../packages/cli/dist/bin/cordon.js');
const transport = new StdioClientTransport({
  command: 'node',
  args: [cordonBin, 'start', '--config', tempConfigPath],
});

const client = new Client({ name: 'demo', version: '0.1.0' });
await client.connect(transport);
transport.stderr?.pipe(process.stderr);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m', yellow: '\x1b[33m',
};

function divider() {
  process.stdout.write(`${c.dim}────────────────────────────────────────────────────${c.reset}\n`);
}

async function step(label: string, tool: string, args: Record<string, unknown>) {
  await sleep(800);
  process.stdout.write(`\n${c.dim}agent ›${c.reset} ${c.cyan}${tool}${c.reset}(${c.dim}${JSON.stringify(args)}${c.reset})\n`);
  await sleep(600);
  const result = await client.callTool({ name: tool, arguments: args });
  const blocked = result.isError === true;
  const text = (Array.isArray(result.content) ? (result.content[0] as { text?: string })?.text : '') ?? '';

  if (blocked) {
    process.stdout.write(`${c.red}${c.bold}  ✗ BLOCKED${c.reset}  ${text.replace(/^\[cordon\] /, '')}\n`);
  } else {
    process.stdout.write(`${c.green}  ✓ allowed${c.reset}  ${c.dim}${text}${c.reset}\n`);
  }
  await sleep(400);
  process.stdout.write(`${c.dim}        ${label}${c.reset}\n`);
}

divider();
process.stdout.write(`${c.bold}cordon for mcp${c.reset}  ${c.dim}— per-agent policy + call-graph constraints${c.reset}\n`);
divider();

// Show the rule first so viewers know what's being enforced.
process.stdout.write(`\n${c.dim}// cordon.config.ts${c.reset}\n`);
process.stdout.write(`${c.dim}callGraph: [${c.reset}\n`);
process.stdout.write(`${c.dim}  { from: ${c.reset}${c.yellow}'read_data'${c.reset}${c.dim}, to: ${c.reset}${c.yellow}'write_file'${c.reset}${c.dim}, action: ${c.reset}${c.yellow}'block'${c.reset}${c.dim} },${c.reset}\n`);
process.stdout.write(`${c.dim}]${c.reset}\n`);

await step('individually allowed', 'read_data', { table: 'customers' });
await step('chain matches the rule — blocked', 'write_file', { path: '/tmp/exfil.txt', content: '...' });

await sleep(600);
divider();
process.stdout.write(`${c.dim}each call was individually allowed. the${c.reset} ${c.bold}sequence${c.reset} ${c.dim}got caught.${c.reset}\n`);
divider();

await client.close();
unlinkSync(tempConfigPath);
process.exit(0);
