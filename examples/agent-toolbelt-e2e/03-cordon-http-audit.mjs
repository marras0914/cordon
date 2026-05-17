#!/usr/bin/env node
// 03-cordon-http-audit.mjs
//
// The big one. Starts Cordon with HTTP transport (Architecture A) and
// agent-toolbelt as a stdio upstream, then connects an MCP client over
// http://127.0.0.1:7777/mcp with Bearer auth. Calls `list_tools` (Agent
// Toolbelt's free metadata tool) so we trigger a real tool call without
// burning API credits. Reads Cordon's stderr to confirm a tool_call_received
// audit entry was captured.

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

const TMP_DIR = resolve(HERE, '.tmp-config/http');
const TMP_CONFIG = resolve(TMP_DIR, 'cordon.config.ts');

const PORT = 7777;
const HOST = '127.0.0.1';
const GATEWAY_URL = `http://${HOST}:${PORT}/mcp`;
const GATEWAY_TOKEN = process.env.CORDON_GATEWAY_TOKEN ?? `e2e-${randomBytes(8).toString('hex')}`;
const LISTEN_PATTERN = /HTTP gateway listening on/;

function fail(msg, ctx = '') {
  process.stderr.write(`\x1b[31m[03-fail]\x1b[0m ${msg}\n${ctx}\n`);
  process.exit(1);
}
function info(msg) {
  process.stderr.write(`[03] ${msg}\n`);
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
  audit: { enabled: true, output: 'stdout' },
  approvals: { channel: 'terminal' },
};
`;
writeFileSync(TMP_CONFIG, configSource);
info(`wrote temp config: ${TMP_CONFIG}`);
info(`gateway will listen on ${GATEWAY_URL} (token: ${GATEWAY_TOKEN.slice(0, 12)}...)`);

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
    fail(`cordon exited with code ${code} before client finished`, stderrLines.slice(-20).join('\n'));
  }
});

async function waitForListen(timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stderrLines.some((l) => LISTEN_PATTERN.test(l))) return;
    if (cordonExited) throw new Error('cordon exited before listening');
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for "HTTP gateway listening" after ${timeoutMs}ms`);
}

async function cleanup() {
  shuttingDown = true;
  if (!cordonExited) {
    cordon.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (!cordonExited) cordon.kill('SIGKILL');
  }
}

try {
  await waitForListen();
  info('cordon HTTP gateway is listening');

  const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL), {
    requestInit: { headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` } },
  });
  const client = new Client({ name: 'cordon-e2e-03', version: '0.0.0' }, { capabilities: {} });

  await client.connect(transport);
  info('HTTP client connected to cordon');

  const { tools } = await client.listTools();
  info(`cordon listed ${tools.length} tools over HTTP`);
  if (!tools.find((t) => t.name === 'list_tools')) {
    fail('list_tools not present — cannot proceed to call stage', `tools: ${tools.map((t) => t.name).slice(0, 10).join(', ')}`);
  }

  info('calling list_tools through cordon HTTP gateway...');
  const callResult = await client.callTool({ name: 'list_tools', arguments: {} });
  const text = (callResult?.content ?? [])
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (!text || text.length < 50) {
    fail(`list_tools returned suspiciously short result: ${JSON.stringify(callResult).slice(0, 200)}`);
  }
  info(`list_tools returned ${text.length} chars of catalog content`);

  await client.close();

  await new Promise((r) => setTimeout(r, 250));

  const auditEntries = [];
  for (const line of stderrLines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.event && obj.timestamp) auditEntries.push(obj);
    } catch {
      // not a JSON audit line — ignore
    }
  }

  info(`captured ${auditEntries.length} audit entries from cordon stderr`);
  const received = auditEntries.find((e) => e.event === 'tool_call_received' && e.toolName === 'list_tools');
  const completed = auditEntries.find((e) => e.event === 'tool_call_completed' && e.toolName === 'list_tools');

  if (!received) {
    fail(
      'no tool_call_received audit entry for list_tools',
      `audit entries seen: ${auditEntries.map((e) => `${e.event}(${e.toolName ?? '-'})`).join(', ') || '(none)'}`,
    );
  }
  info(`tool_call_received captured: server=${received.serverName ?? '?'} tool=${received.toolName} args=${JSON.stringify(received.args ?? {})}`);
  if (completed) {
    info(`tool_call_completed captured: durationMs=${completed.durationMs ?? '?'}`);
  } else {
    info('note: no tool_call_completed event seen — call may not have finished before stderr drain. Not a hard fail.');
  }

  info('pass — HTTP transport works, audit log captures Agent Toolbelt calls');
} catch (err) {
  fail(`HTTP e2e failed: ${err?.message ?? err}`, `\ncordon stderr tail:\n${stderrLines.slice(-25).join('\n')}`);
} finally {
  await cleanup();
}

process.exit(0);
