#!/usr/bin/env node
// 02-cordon-stdio.mjs
//
// Spawns Cordon with agent-toolbelt configured as a stdio upstream, then
// connects an MCP client to Cordon over stdio. Asserts the agent-toolbelt
// tools surface through Cordon's tool registry. Writes a temp cordon.config.ts
// to a fresh subdirectory under .tmp-config/.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

const TOOLBELT_MCP =
  process.env.AGENT_TOOLBELT_MCP_PATH ||
  resolve(HERE, 'node_modules/agent-toolbelt-mcp/build/index.js');
const CORDON_CLI =
  process.env.CORDON_CLI_PATH ||
  resolve(HERE, 'node_modules/@getcordon/cli/dist/bin/cordon.js');

const TMP_DIR = resolve(HERE, '.tmp-config/stdio');
const TMP_CONFIG = resolve(TMP_DIR, 'cordon.config.ts');

function fail(msg) {
  process.stderr.write(`\x1b[31m[02-fail]\x1b[0m ${msg}\n`);
  process.exit(1);
}
function info(msg) {
  process.stderr.write(`[02] ${msg}\n`);
}

if (!existsSync(TOOLBELT_MCP)) {
  fail(`agent-toolbelt MCP server not found at ${TOOLBELT_MCP}\n  fix: npm install`);
}
if (!existsSync(CORDON_CLI)) {
  fail(`Cordon CLI not found at ${CORDON_CLI}\n  fix: npm install`);
}

// Recreate temp config dir
rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });

const apiKey = process.env.AGENT_TOOLBELT_KEY ?? '';
const apiUrl = process.env.AGENT_TOOLBELT_URL ?? 'https://agent-toolbelt-production.up.railway.app';

// Plain object config — no defineConfig() import, jiti loads it as-is.
const configSource = `export default {
  servers: [
    {
      name: 'agent-toolbelt',
      transport: 'stdio',
      command: ${JSON.stringify(process.execPath)},
      args: [${JSON.stringify(TOOLBELT_MCP)}],
      env: {
        AGENT_TOOLBELT_URL: ${JSON.stringify(apiUrl)},
        AGENT_TOOLBELT_KEY: ${JSON.stringify(apiKey)},
      },
      policy: 'allow',
    },
  ],
  audit: { enabled: true, output: 'stdout' },
  approvals: { channel: 'terminal' },
};
`;
writeFileSync(TMP_CONFIG, configSource);
info(`wrote temp config: ${TMP_CONFIG}`);

info(`spawning cordon start --config ${TMP_CONFIG}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [CORDON_CLI, 'start', '--config', TMP_CONFIG],
  env: process.env,
  stderr: 'pipe',
});

// Attach stderr listener BEFORE connect so we capture early failures.
const stderrChunks = [];
transport.stderr?.on('data', (b) => stderrChunks.push(b.toString('utf-8')));

const client = new Client({ name: 'cordon-e2e-02', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  info('connected to cordon — calling tools/list');
  const { tools } = await client.listTools();
  info(`cordon returned: ${tools.length} tools`);

  if (tools.length < 25) {
    fail(`expected >=25 tools through cordon, got ${tools.length}\n  cordon stderr tail:\n${stderrChunks.join('').split('\n').slice(-15).join('\n')}`);
  }

  const names = new Set(tools.map((t) => t.name));
  if (!names.has('stock_thesis')) {
    fail(`stock_thesis not surfaced through cordon\n  saw: ${[...names].slice(0, 10).join(', ')}...`);
  }

  info(`pass — ${tools.length} tools surfaced through Cordon stdio gateway`);
} catch (err) {
  const tail = stderrChunks.join('').split('\n').slice(-15).join('\n');
  fail(`client connect/list through cordon failed: ${err?.message ?? err}\n  cordon stderr tail:\n${tail}`);
} finally {
  await client.close().catch(() => {});
}

process.exit(0);
