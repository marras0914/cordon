#!/usr/bin/env node
// 01-toolbelt-direct.mjs
//
// Connects an MCP client straight to agent-toolbelt's MCP server over stdio,
// no Cordon in the path. Asserts the server starts, lists >=25 tools, and
// includes `stock_thesis` (the tool the walkthrough claims will show up in
// the audit log). Exits 0 on pass, non-zero with a clear reason on fail.

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

// agent-toolbelt-mcp is a local npm dependency. Use the bin entry under
// node_modules directly. Override with AGENT_TOOLBELT_MCP_PATH to point
// at a local Agent Toolbelt checkout.
const TOOLBELT_MCP =
  process.env.AGENT_TOOLBELT_MCP_PATH ||
  resolve(HERE, 'node_modules/agent-toolbelt-mcp/build/index.js');

const REQUIRED_TOOLS = ['stock_thesis', 'list_tools', 'count_tokens'];
const MIN_TOOL_COUNT = 25;

function fail(msg) {
  process.stderr.write(`\x1b[31m[01-fail]\x1b[0m ${msg}\n`);
  process.exit(1);
}
function info(msg) {
  process.stderr.write(`[01] ${msg}\n`);
}

if (!existsSync(TOOLBELT_MCP)) {
  fail(`agent-toolbelt MCP server entry not found at ${TOOLBELT_MCP}\n  fix: npm install (in this directory)`);
}

const apiKey = process.env.AGENT_TOOLBELT_KEY;
if (!apiKey) {
  info('AGENT_TOOLBELT_KEY not set — proceeding anyway (tools/list does not require auth)');
}

info(`spawning ${TOOLBELT_MCP}`);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [TOOLBELT_MCP],
  env: {
    ...process.env,
    AGENT_TOOLBELT_URL: process.env.AGENT_TOOLBELT_URL ?? 'https://agent-toolbelt-production.up.railway.app',
    ...(apiKey ? { AGENT_TOOLBELT_KEY: apiKey } : {}),
  },
});

const client = new Client({ name: 'cordon-e2e-01', version: '0.0.0' }, { capabilities: {} });

try {
  await client.connect(transport);
  info('connected — calling tools/list');

  const { tools } = await client.listTools();
  info(`tools returned: ${tools.length}`);

  if (tools.length < MIN_TOOL_COUNT) {
    fail(`expected >=${MIN_TOOL_COUNT} tools, got ${tools.length}`);
  }

  const names = new Set(tools.map((t) => t.name));
  const missing = REQUIRED_TOOLS.filter((n) => !names.has(n));
  if (missing.length > 0) {
    fail(`missing expected tools: ${missing.join(', ')}\n  saw: ${[...names].slice(0, 10).join(', ')}...`);
  }

  info(`pass — ${tools.length} tools, all required tools present`);
  info(`sample: ${[...names].slice(0, 6).join(', ')}, ...`);
} catch (err) {
  fail(`client connect/list failed: ${err?.message ?? err}`);
} finally {
  await client.close().catch(() => {});
}

process.exit(0);
