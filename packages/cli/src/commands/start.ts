import { CordonGateway } from '@getcordon/core';
import type { ResolvedConfig } from 'cordon-sdk';
import { emptyConfig, findConfigPath, loadConfig } from '../config-loader.js';
import { getState, setState, getAuth } from '../cli-state.js';

const DASHBOARD_URL = 'https://cordon-server-production.up.railway.app/dashboard/';

function applyAuthDefaults(config: ResolvedConfig): ResolvedConfig {
  const auth = getAuth();
  if (!auth) return config;

  const audit = config.audit;
  const usesHosted = audit && (audit.output === 'hosted' || (Array.isArray(audit.output) && audit.output.includes('hosted')));
  if (!usesHosted) return config;
  if (audit.endpoint && audit.apiKey) return config;

  return {
    ...config,
    audit: {
      ...audit,
      endpoint: audit.endpoint ?? auth.endpoint,
      apiKey: audit.apiKey ?? auth.apiKey,
    },
  };
}

interface StartOptions {
  config?: string;
}

export async function startCommand(options: StartOptions): Promise<void> {
  if (!getState().welcomed && !getAuth()) {
    process.stderr.write(
      `\n\x1b[36m[cordon] Want centralized audit logs + Slack approvals?\x1b[0m\n` +
      `[cordon] Run \`cordon login\` or register at ${DASHBOARD_URL}?utm_source=cli_start\n\n`,
    );
    setState({ welcomed: true });
  }

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

  config = applyAuthDefaults(config);

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
