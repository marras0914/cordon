import { CordonGateway } from '@getcordon/core';
import { findConfigPath, loadConfig } from '../config-loader.js';

interface StartOptions {
  config?: string;
}

export async function startCommand(options: StartOptions): Promise<void> {
  let configPath: string;
  try {
    configPath = await findConfigPath(options.config);
  } catch (err) {
    process.stderr.write(`\x1b[31merror\x1b[0m: ${String(err)}\n`);
    process.exit(1);
  }

  process.stderr.write(`[cordon] loading config from ${configPath}\n`);

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(configPath);
  } catch (err) {
    process.stderr.write(`\x1b[31merror\x1b[0m: ${String(err)}\n`);
    process.exit(1);
  }

  const gateway = new CordonGateway(config);

  const shutdown = async () => {
    process.stderr.write('\n[cordon] shutting down...\n');
    await gateway.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await gateway.start();
  } catch (err) {
    process.stderr.write(`\x1b[31merror\x1b[0m: gateway failed: ${String(err)}\n`);
    process.exit(1);
  }
}
