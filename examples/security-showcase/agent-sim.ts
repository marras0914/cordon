/**
 * Simulates an AI agent making a sequence of tool calls through Cordon.
 *
 * The agent starts benign (safe reads), escalates to writes that trigger
 * the approval prompt, then attempts truly dangerous operations that are
 * blocked outright regardless of approval.
 *
 * Run:  npm run demo
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Terminal colours ──────────────────────────────────────────────────────────
const R = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function out(msg: string) { process.stdout.write(msg + '\n'); }

// ── Demo scenario ─────────────────────────────────────────────────────────────

const STEPS = [
  {
    label: 'Reading customer records',
    note: 'safe read — should pass through automatically',
    tool: 'read_data',
    args: { table: 'customers', limit: 10 },
  },
  {
    label: 'Fetching active sessions',
    note: 'safe read — should pass through automatically',
    tool: 'read_data',
    args: { table: 'sessions' },
  },
  {
    label: 'Running a SELECT query',
    note: 'execute_ prefix triggers approval even for reads — Cordon errs on the side of caution',
    tool: 'execute_sql',
    args: { query: 'SELECT id, email FROM users WHERE active = true LIMIT 50' },
  },
  {
    label: 'Deleting expired sessions',
    note: 'write — should trigger approval prompt',
    tool: 'execute_sql',
    args: { query: 'DELETE FROM sessions WHERE expires_at < NOW()' },
  },
  {
    label: 'Writing a config override',
    note: 'write — should trigger approval prompt',
    tool: 'write_file',
    args: { path: '/etc/app/feature-flags.json', content: '{ "new_billing": true }' },
  },
  {
    label: 'Dropping the users table',
    note: 'BLOCKED regardless of approval',
    tool: 'drop_table',
    args: { table: 'users' },
  },
  {
    label: 'Deleting production logs',
    note: 'BLOCKED regardless of approval',
    tool: 'delete_file',
    args: { path: '/var/log/app/production.log' },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  out(`\n${BOLD}${CYAN}╔══════════════════════════════════════════╗${R}`);
  out(`${BOLD}${CYAN}║  Cordon — Security Showcase              ║${R}`);
  out(`${BOLD}${CYAN}╚══════════════════════════════════════════╝${R}`);
  out(`\n${DIM}Simulating an AI agent with access to a production database.${R}`);
  out(`${DIM}Watch how Cordon handles each tool call.${R}\n`);

  // Point at the locally-built cordon CLI binary
  const cordonBin = join(__dirname, '../../packages/cli/dist/bin/cordon.js');
  const configPath = join(__dirname, 'cordon.config.ts');

  const transport = new StdioClientTransport({
    command: 'node',
    args: [cordonBin, 'start', '--config', configPath],
  });

  const client = new Client({ name: 'agent-sim', version: '0.1.0' });

  out(`${DIM}Starting Cordon...${R}\n`);
  try {
    await client.connect(transport);
    // Pipe Cordon's stderr (approval prompts, audit logs) to our stderr.
    // Must be done after connect() — the stream is created when the child process spawns.
    transport.stderr?.pipe(process.stderr);
  } catch (err) {
    process.stderr.write(`${RED}Failed to start Cordon gateway: ${String(err)}${R}\n`);
    process.exit(1);
  }

  const { tools } = await client.listTools();
  out(`${DIM}Gateway ready. Tools available: ${tools.map((t) => t.name).join(', ')}${R}`);
  out(`\n${'─'.repeat(54)}`);

  let passed = 0;
  let blocked = 0;
  let approved = 0;
  let denied = 0;

  for (const step of STEPS) {
    out(`\n${BOLD}🤖 Agent:${R} ${step.label}`);
    out(`   ${DIM}${step.tool}(${JSON.stringify(step.args)})${R}`);
    out(`   ${DIM}Expected: ${step.note}${R}`);

    let result: Awaited<ReturnType<typeof client.callTool>>;
    try {
      result = await client.callTool({ name: step.tool, arguments: step.args });
    } catch (err) {
      out(`   ${RED}✗ Error${R}: ${String(err)}`);
      continue;
    }

    const text = (result.content[0] as { text?: string })?.text ?? '(no response)';

    if (result.isError) {
      // Blocked or denied
      if (text.includes('Denied')) {
        denied++;
        out(`   ${YELLOW}✗ Denied${R}: ${text}`);
      } else {
        blocked++;
        out(`   ${RED}✗ Blocked${R}: ${text}`);
      }
    } else {
      passed++;
      out(`   ${GREEN}✓ Success${R}: ${text}`);
    }
  }

  out(`\n${'─'.repeat(54)}`);
  out(`\n${BOLD}Results${R}`);
  out(`  ${GREEN}✓ Passed${R}:  ${passed}`);
  out(`  ${GREEN}✓ Approved${R}: ${approved}`);
  out(`  ${YELLOW}✗ Denied${R}:  ${denied}`);
  out(`  ${RED}✗ Blocked${R}: ${blocked}`);
  out(`\n${DIM}Full audit trail written to cordon-audit.log${R}\n`);

  await client.close();
}

main().catch((err) => {
  process.stderr.write(`\nFatal error: ${String(err)}\n`);
  process.exit(1);
});
