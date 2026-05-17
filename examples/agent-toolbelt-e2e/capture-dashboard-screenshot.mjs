#!/usr/bin/env node
// capture-dashboard-screenshot.mjs
//
// One-shot helper for capturing a dashboard screenshot showing a real
// `list_tools` call routed through Cordon. Same as 03-cordon-http-audit.mjs
// but with `audit.output: 'hosted'` so the event lands in app.getcordon.com
// instead of stderr.
//
// Usage:
//   export CORDON_API_KEY=crd_your_key_here
//   export AGENT_TOOLBELT_KEY=atb_your_key_here   # optional; list_tools doesn't need it
//   node capture-dashboard-screenshot.mjs
//
// Then open https://app.getcordon.com/dashboard/ and screenshot the row.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

const TOOLBELT_MCP =
  process.env.AGENT_TOOLBELT_MCP_PATH ||
  resolve(HERE, 'node_modules/agent-toolbelt-mcp/build/index.js');
const CORDON_CLI =
  process.env.CORDON_CLI_PATH ||
  resolve(HERE, 'node_modules/@getcordon/cli/dist/bin/cordon.js');

const TMP_DIR = resolve(HERE, '.tmp-config/hosted');
const TMP_CONFIG = resolve(TMP_DIR, 'cordon.config.ts');

const PORT = 7777;
const HOST = '127.0.0.1';
const GATEWAY_URL = `http://${HOST}:${PORT}/mcp`;
const GATEWAY_TOKEN = process.env.CORDON_GATEWAY_TOKEN ?? `cap-${randomBytes(8).toString('hex')}`;
const HOSTED_ENDPOINT = process.env.CORDON_ENDPOINT ?? 'https://app.getcordon.com';
const LISTEN_PATTERN = /HTTP gateway listening on/;

// Hosted audit output flushes every 2s or at batch size 100, whichever first.
// We wait 4s after the call to be safe — the batch should be at the server
// well before then.
const HOSTED_FLUSH_WAIT_MS = 4000;

function fail(msg, ctx = '') {
  process.stderr.write(`\x1b[31m[capture-fail]\x1b[0m ${msg}\n${ctx}\n`);
  process.exit(1);
}
function info(msg) {
  process.stderr.write(`[capture] ${msg}\n`);
}
function ok(msg) {
  process.stderr.write(`\x1b[32m[capture]\x1b[0m ${msg}\n`);
}

const cordonApiKey = process.env.CORDON_API_KEY;
if (!cordonApiKey || !cordonApiKey.startsWith('crd_')) {
  fail(
    'CORDON_API_KEY is not set (must start with `crd_`). Get a key from app.getcordon.com/dashboard.',
  );
}

if (!existsSync(TOOLBELT_MCP)) fail(`agent-toolbelt MCP server not found at ${TOOLBELT_MCP}\n  fix: npm install`);
if (!existsSync(CORDON_CLI)) fail(`Cordon CLI not found at ${CORDON_CLI}\n  fix: npm install`);

rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });

const apiKey = process.env.AGENT_TOOLBELT_KEY ?? '';
const apiUrl = process.env.AGENT_TOOLBELT_URL ?? 'https://agent-toolbelt-production.up.railway.app';

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
  gateway: {
    transport: 'http',
    port: ${PORT},
    host: ${JSON.stringify(HOST)},
    authToken: ${JSON.stringify(GATEWAY_TOKEN)},
  },
  audit: {
    enabled: true,
    output: 'hosted',
    endpoint: ${JSON.stringify(HOSTED_ENDPOINT)},
    apiKey: ${JSON.stringify(cordonApiKey)},
  },
  approvals: { channel: 'terminal' },
};
`;
writeFileSync(TMP_CONFIG, configSource);
info(`wrote temp config: ${TMP_CONFIG}`);
info(`hosted audit endpoint: ${HOSTED_ENDPOINT}`);

const cordon = spawn(process.execPath, [CORDON_CLI, 'start', '--config', TMP_CONFIG], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: process.env,
});

const stderrLines = [];
let stderrBuf = '';
cordon.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString('utf-8');
  const lines = stderrBuf.split('\n');
  stderrBuf = lines.pop() ?? '';
  for (const line of lines) stderrLines.push(line);
});

let cordonExited = false;
let shuttingDown = false;
cordon.on('exit', (code) => {
  cordonExited = true;
  if (!shuttingDown && code !== null && code !== 0) {
    fail(`cordon exited with code ${code}`, stderrLines.slice(-20).join('\n'));
  }
});

async function waitForListen(timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stderrLines.some((l) => LISTEN_PATTERN.test(l))) return;
    if (cordonExited) throw new Error('cordon exited before listening');
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for cordon to listen after ${timeoutMs}ms`);
}

async function cleanup() {
  shuttingDown = true;
  if (!cordonExited) {
    cordon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (!cordonExited) cordon.kill('SIGKILL');
  }
}

try {
  await waitForListen();
  info('cordon HTTP gateway is listening');

  const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL), {
    requestInit: { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } },
  });
  const client = new Client({ name: 'cordon-screenshot-capture', version: '0.0.0' }, { capabilities: {} });

  await client.connect(transport);
  info('MCP client connected');

  info('calling list_tools through cordon...');
  const callResult = await client.callTool({ name: 'list_tools', arguments: {} });
  const text = (callResult?.content ?? [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (!text || text.length < 50) {
    fail(`list_tools returned suspiciously short result: ${JSON.stringify(callResult).slice(0, 200)}`);
  }
  info(`list_tools returned ${text.length} chars — call completed successfully`);

  await client.close();

  info(`waiting ${HOSTED_FLUSH_WAIT_MS}ms for hosted audit batch to flush...`);
  await new Promise((r) => setTimeout(r, HOSTED_FLUSH_WAIT_MS));

  ok('done. Event should be in your dashboard now.');
  ok(`open ${HOSTED_ENDPOINT}/dashboard/ and screenshot the audit log row.`);
  ok(`look for: tool=list_tools server=agent-toolbelt (within the last minute)`);
} catch (err) {
  fail(`capture failed: ${err?.message ?? err}`, `\ncordon stderr tail:\n${stderrLines.slice(-25).join('\n')}`);
} finally {
  await cleanup();
}

process.exit(0);
