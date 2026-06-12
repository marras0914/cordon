/**
 * Seed real audit events into the HOSTED Cordon backend so the dashboard's
 * "Suggested policies" panel (AI policy auto-generation) has something to chew on.
 *
 * Spins up a real Cordon gateway over stdio wrapping the mock dangerous-server,
 * points audit output at the hosted backend with your API key, and drives a
 * realistic call mix that exercises every Stage 1 heuristic:
 *   - a burst of reads            → rate_limit candidate
 *   - read_data → write_file ×N   → call_graph (read-then-write) candidate
 *   - ungated writes              → approve candidates
 *   - ungated destructive ops     → block candidates
 *
 * Every tool is policy 'allow' so nothing prompts or blocks — each call just
 * fires and emits received/allowed/completed events. The dangerous-server tools
 * are mocks (no real files touched).
 *
 * Usage (key from env, or ~/.cordon/auth.json if you've run `cordon login`):
 *   CORDON_API_KEY=crd_... npx tsx seed-hosted.ts
 *   npx tsx seed-hosted.ts                      # reads ~/.cordon/auth.json
 *
 * Endpoint defaults to the hosted instance; override with CORDON_ENDPOINT.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Resolve credentials ────────────────────────────────────────────────────────
let apiKey = process.env.CORDON_API_KEY ?? '';
let endpoint = process.env.CORDON_ENDPOINT ?? '';
const authPath = join(homedir(), '.cordon', 'auth.json');
if ((!apiKey || !endpoint) && existsSync(authPath)) {
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as { apiKey?: string; endpoint?: string };
    if (!apiKey && auth.apiKey) apiKey = auth.apiKey;
    if (!endpoint && auth.endpoint) endpoint = auth.endpoint;
  } catch { /* ignore */ }
}
endpoint = endpoint || 'https://app.getcordon.com';

if (!apiKey) {
  process.stderr.write('No API key. Set CORDON_API_KEY=crd_... or run `cordon login` first.\n');
  process.exit(1);
}
process.stdout.write(`Seeding hosted audit → ${endpoint} (key ${apiKey.slice(0, 8)}…)\n`);

// ── Temp hosted-audit config (all 'allow' so nothing prompts/blocks) ────────────
const tempConfig = `
import { defineConfig } from '@getcordon/policy';
import { join } from 'node:path';
export default defineConfig({
  agentId: 'seed-agent',
  servers: [{
    name: 'demo-db',
    transport: 'stdio',
    command: 'npx',
    args: ['tsx', join(${JSON.stringify(__dirname)}, 'dangerous-server.ts')],
    policy: 'allow',
  }],
  audit: {
    enabled: true,
    output: 'hosted',
    endpoint: ${JSON.stringify(endpoint)},
    apiKey: ${JSON.stringify(apiKey)},
  },
});
`;
const tempConfigPath = join(__dirname, '_seed-config.ts');
writeFileSync(tempConfigPath, tempConfig);

const cordonBin = join(__dirname, '../../packages/cli/dist/bin/cordon.js');
const transport = new StdioClientTransport({
  command: 'node',
  args: [cordonBin, 'start', '--config', tempConfigPath],
});

const client = new Client({ name: 'seed-hosted', version: '0.1.0' });
await client.connect(transport);
transport.stderr?.pipe(process.stderr);

// ── The call sequence — each entry is one tool call ─────────────────────────────
type Call = { tool: string; args: Record<string, unknown> };
const calls: Call[] = [];

// 1) Burst of reads (12 in quick succession) → rate_limit candidate on read_data.
for (let i = 0; i < 12; i++) calls.push({ tool: 'read_data', args: { table: `t${i}` } });

// 2) read_data → write_file pairs ×4 (consecutive) → call_graph (read-then-write).
for (let i = 0; i < 4; i++) {
  calls.push({ tool: 'read_data', args: { table: 'customers' } });
  calls.push({ tool: 'write_file', args: { path: `/tmp/export-${i}.csv`, content: 'rows' } });
}

// 3) Ungated writes → approve candidates.
for (let i = 0; i < 3; i++) calls.push({ tool: 'execute_sql', args: { query: 'UPDATE accounts SET x=1' } });

// 4) Ungated destructive ops → block candidates.
calls.push({ tool: 'drop_table', args: { table: 'audit_logs' } });
calls.push({ tool: 'drop_table', args: { table: 'sessions' } });
calls.push({ tool: 'delete_file', args: { path: '/var/data/old.db' } });
calls.push({ tool: 'delete_file', args: { path: '/tmp/scratch' } });

let ok = 0;
for (const c of calls) {
  try {
    await client.callTool({ name: c.tool, arguments: c.args });
    ok++;
  } catch (e) {
    process.stderr.write(`call ${c.tool} failed: ${String(e)}\n`);
  }
}
process.stdout.write(`Made ${ok}/${calls.length} calls. Waiting for hosted audit to flush…\n`);

// Hosted audit flushes every 2s (fire-and-forget). Keep the gateway alive long
// enough for the timer to fire AND the POST /events fetch to complete.
await new Promise((r) => setTimeout(r, 5000));

await client.close();
unlinkSync(tempConfigPath);
process.stdout.write('Done. Open the dashboard → select your key → Analyze my logs.\n');
process.exit(0);
