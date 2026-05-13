/**
 * End-to-end test of the HTTP/Streamable HTTP gateway transport.
 *
 * Starts a CordonGateway in HTTP mode against the dangerous-server upstream,
 * then connects an MCP Client via the SDK's StreamableHTTPClientTransport
 * (the same transport n8n's MCP Client Tool node uses internally) and
 * exercises the full protocol: initialize → tools/list → tools/call.
 *
 * Run with: cd examples/security-showcase && npx tsx http-e2e-test.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CordonGateway } from '@getcordon/core';
import type { ResolvedConfig } from '@getcordon/policy';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN = 'e2e-test-token-' + Math.random().toString(36).slice(2);
const PORT = 7979;
const HOST = '127.0.0.1';
const GATEWAY_URL = `http://${HOST}:${PORT}/mcp`;

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
  gateway: { transport: 'http', authToken: TOKEN, port: PORT, host: HOST },
};

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  const mark = cond ? '✓' : '✗';
  process.stdout.write(`  ${mark} ${name}${detail ? ' — ' + detail : ''}\n`);
  if (cond) pass++;
  else fail++;
}

async function main(): Promise<void> {
  const gateway = new CordonGateway(config);
  await gateway.start();
  process.stdout.write(`[e2e] gateway up on ${GATEWAY_URL}\n\n`);

  try {
    const transport = new StreamableHTTPClientTransport(new URL(GATEWAY_URL), {
      requestInit: {
        headers: { Authorization: `Bearer ${TOKEN}` },
      },
    });

    const client = new Client({ name: 'cordon-e2e', version: '0.1.0' });
    await client.connect(transport);
    check('client connects via Streamable HTTP', true);

    const list = await client.listTools();
    check('tools/list returns array', Array.isArray(list.tools), `got ${list.tools.length} tools`);

    const toolNames = list.tools.map((t) => t.name);
    if (toolNames.length > 0) {
      process.stdout.write(
        `    advertised: ${toolNames.slice(0, 5).join(', ')}${toolNames.length > 5 ? ', ...' : ''}\n`,
      );

      // Call the first tool. It may error if args are required — that's still
      // a valid round-trip through the protocol. We only fail this check if
      // the call itself throws (transport / session breakage), not on
      // tool-level isError.
      const first = list.tools[0];
      try {
        const result = await client.callTool({ name: first.name, arguments: {} });
        check(
          `tools/call ${first.name} completes round-trip`,
          true,
          `isError=${result.isError ?? false}`,
        );
      } catch (err) {
        check(`tools/call ${first.name} completes round-trip`, false, String(err));
      }
    } else {
      check('upstream surfaces tools', false, '0 tools advertised');
    }

    await client.close();
    check('client closes cleanly', true);
  } catch (err) {
    check('e2e flow without protocol errors', false, String(err));
  } finally {
    await gateway.stop();
    process.stdout.write(`\n[e2e] gateway stopped\n`);
  }

  process.stdout.write(`\n[e2e] ${pass}/${pass + fail} checks passed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[e2e] fatal: ${err}\n`);
  process.exit(1);
});
