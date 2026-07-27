import { Command } from 'commander';
import { startCommand } from '../commands/start.js';
import { initCommand } from '../commands/init.js';
import { loginCommand } from '../commands/login.js';
import { logoutCommand } from '../commands/logout.js';
import { replayCommand } from '../commands/replay.js';

const program = new Command();

program
  .name('cordon')
  .description('Cordon for MCP — security gateway for MCP tool calls')
  .version('0.1.0');

program
  .command('start')
  .description('Start the Cordon gateway')
  .option('-c, --config <path>', 'Path to cordon.config.ts')
  .option('--http', 'Enable HTTP transport (for n8n and other HTTP-speaking MCP clients). Requires CORDON_GATEWAY_TOKEN env var or gateway.authToken in config.')
  .option('--port <port>', 'Port for HTTP transport (default: 7777)', (v) => Number.parseInt(v, 10))
  .action(startCommand);

program
  .command('init')
  .description('Generate cordon.config.ts and patch Claude Desktop config')
  .action(initCommand);

program
  .command('login')
  .description('Log in to Cordon (browser OAuth) and save an API key locally')
  .option('--endpoint <url>', 'Cordon server endpoint (defaults to the hosted instance)')
  .action((opts) => loginCommand(opts).catch((err) => {
    process.stderr.write(`\x1b[31merror\x1b[0m: login failed: ${String(err)}\n`);
    process.exit(1);
  }));

program
  .command('logout')
  .description('Remove the local Cordon credentials')
  .action(logoutCommand);

program
  .command('replay <callId>')
  .description('Re-execute a tool call that was approved after it timed out')
  .option('-c, --config <path>', 'Path to cordon.config.ts')
  .option('--endpoint <url>', 'Cordon server endpoint (defaults to your logged-in instance)')
  .option('--yes', 'Skip the confirmation prompt')
  .action((callId, opts) => replayCommand(callId, opts).catch((err) => {
    process.stderr.write(`\x1b[31merror\x1b[0m: replay failed: ${String(err)}\n`);
    process.exit(1);
  }));

program.parse();
