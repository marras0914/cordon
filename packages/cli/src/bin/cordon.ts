import { Command } from 'commander';
import { startCommand } from '../commands/start.js';
import { initCommand } from '../commands/init.js';
import { loginCommand } from '../commands/login.js';
import { logoutCommand } from '../commands/logout.js';

const program = new Command();

program
  .name('cordon')
  .description('Cordon for MCP — security gateway for MCP tool calls')
  .version('0.1.0');

program
  .command('start')
  .description('Start the Cordon gateway')
  .option('-c, --config <path>', 'Path to cordon.config.ts')
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

program.parse();
