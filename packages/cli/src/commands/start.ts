import { CordonGateway } from '@getcordon/core';
import type { ResolvedConfig } from 'cordon-sdk';
import { emptyConfig, findConfigPath, loadConfig } from '../config-loader.js';

interface StartOptions {
  config?: string;
}

export async function startCommand(options: StartOptions): Promise<void> {
  // Default to an empty server list so auto-install probes (Glama, MCP
  // registry, fresh `npx -y cordon-cli start`) succeed instead of crashing.
  // Real users get a loud stderr warning so they don't silently run a no-op.
  let config: ResolvedConfig = emptyConfig();
  let configPath: string | null = null;

  try {
    configPath = await findConfigPath(options.config);
  } catch (err) {
    if (options.config) {
      process.stderr.write(`\x1b[31merror\x1b[0m: ${String(err)}\n`);
      process.exit(1);
    }
    process.stderr.write(
      '\x1b[33m[cordon] no cordon.config.ts found — starting with zero upstream servers.\x1b[0m\n' +
        '[cordon] Run `cordon init` to generate a config and connect real MCP servers.\n',
    );
  }

  if (configPath) {
    process.stderr.write(`[cordon] loading config from ${configPath}\n`);
    try {
      config = await loadConfig(configPath);
    } catch (err) {
      process.stderr.write(`\x1b[31merror\x1b[0m: ${String(err)}\n`);
      process.exit(1);
    }
  }

  const gateway = new CordonGateway(config);

  const shutdown = async () => {
    process.stderr.write('\n[cordon] shutting down...\n');
    try {
      await gateway.stop();
      process.exit(0);
    } catch (err) {
      process.stderr.write(`\x1b[31merror\x1b[0m: shutdown failed: ${String(err)}\n`);
      process.exit(1);
    }
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
