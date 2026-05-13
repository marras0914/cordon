/**
 * Smoke test for the HTTP/Streamable HTTP gateway transport.
 *
 * Starts a CordonGateway in HTTP mode against the local dangerous-server
 * upstream, then exercises the HTTP layer:
 *   - 404 on wrong path
 *   - 401 without Authorization header
 *   - 401 with wrong Bearer token
 *   - non-401 with the valid Bearer token (proves auth passed; actual MCP
 *     protocol semantics are exercised by manual n8n testing)
 *
 * Run with: cd examples/security-showcase && npx tsx http-smoke-test.ts
 */

import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CordonGateway } from '@getcordon/core';
import type { ResolvedConfig } from '@getcordon/policy';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'smoke-test-token-' + Math.random().toString(36).slice(2);
const PORT = 7878;
const HOST = '127.0.0.1';

const config: ResolvedConfig = {
  servers: [
    {
      name: 'demo',
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', join(__dirname, 'dangerous-server.ts')],
      policy: 'allow',
    },
  ],
  audit: { enabled: false },
  gateway: {
    transport: 'http',
    authToken: TOKEN,
    port: PORT,
    host: HOST,
  },
};

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const results: Check[] = [];

function check(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  const mark = pass ? '✓' : '✗';
  process.stdout.write(`  ${mark} ${name} — ${detail}\n`);
}

async function request(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const req = http.request(
      {
        method,
        host: HOST,
        port: PORT,
        path,
        headers,
        timeout: 3000,
      },
      (res) => {
        // Drain so the socket can close even though we ignore the body.
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));

    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main(): Promise<void> {
  const gateway = new CordonGateway(config);

  await gateway.start();
  process.stdout.write(`[smoke] gateway up on http://${HOST}:${PORT}/mcp\n\n`);

  try {
    const r1 = await request('GET', '/wrong');
    check('404 on wrong path', r1.status === 404, `got ${r1.status}`);

    const r2 = await request('GET', '/mcp');
    check('401 with no auth header', r2.status === 401, `got ${r2.status}`);

    const r3 = await request('GET', '/mcp', 'wrong-token-here');
    check('401 with wrong Bearer token', r3.status === 401, `got ${r3.status}`);

    const r4 = await request('GET', '/mcp', '');
    check('401 with empty token after Bearer', r4.status === 401, `got ${r4.status}`);

    // Valid auth — POST with empty body. Transport will likely respond with
    // a 4xx for the malformed JSON-RPC, but the key is auth passed (not 401).
    const r5 = await request('POST', '/mcp', TOKEN, {});
    check(
      'valid Bearer token passes auth',
      r5.status !== 401,
      `got ${r5.status} (not 401)`,
    );
  } finally {
    await gateway.stop();
    process.stdout.write(`\n[smoke] gateway stopped\n`);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  process.stdout.write(`\n[smoke] ${passed}/${total} checks passed\n`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[smoke] fatal: ${err}\n`);
  process.exit(1);
});
