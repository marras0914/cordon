import { Command } from 'commander';
import { startCommand } from '../commands/start.js';
import { initCommand } from '../commands/init.js';

const program = new Command();

program
  .name('cordon')
  .description('The security gateway for AI agents')
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

program.parse();
