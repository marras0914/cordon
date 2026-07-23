import { CordonGateway } from '@getcordon/core';
import type { ResolvedConfig } from '@getcordon/policy';
import { emptyConfig, findConfigPath, loadConfig } from '../config-loader.js';
import { getState, setState, getAuth } from '../cli-state.js';

const DASHBOARD_URL = 'https://app.getcordon.com/dashboard/';

function applyAuthDefaults(config: ResolvedConfig): ResolvedConfig {
  const auth = getAuth();
  if (!auth) return config;

  let next = config;

  // Hosted audit: fill endpoint/apiKey from auth.json when not already set.
  const audit = next.audit;
  const usesHosted =
    audit && (audit.output === 'hosted' || (Array.isArray(audit.output) && audit.output.includes('hosted')));
  if (usesHosted && !(audit.endpoint && audit.apiKey)) {
    next = {
      ...next,
      audit: { ...audit, endpoint: audit.endpoint ?? auth.endpoint, apiKey: audit.apiKey ?? auth.apiKey },
    };
  }

  // Slack approvals are server-driven — fill endpoint/apiKey so the local side
  // can register + poll without the user hand-writing them into the config.
  const approvals = next.approvals;
  if (approvals?.channel === 'slack' && !(approvals.endpoint && approvals.apiKey)) {
    next = {
      ...next,
      approvals: { ...approvals, endpoint: approvals.endpoint ?? auth.endpoint, apiKey: approvals.apiKey ?? auth.apiKey },
    };
  }

  return next;
}

interface StartOptions {
  config?: string;
  /** Enable HTTP/Streamable HTTP transport (overrides config.gateway.transport). */
  http?: boolean;
  /** Port for HTTP transport (overrides config.gateway.port). */
  port?: number;
}

/**
 * Apply CLI flags + env vars on top of the loaded config so the HTTP transport
 * can be enabled without editing the config file. Precedence:
 *   - `--http` flag forces HTTP transport regardless of config.
 *   - `--port` flag overrides config.gateway.port.
 *   - authToken comes from config.gateway.authToken if present, otherwise
 *     the `CORDON_GATEWAY_TOKEN` env var.
 *   - host comes from config (defaults to localhost in core/transport/http.ts).
 */
function applyHttpFlags(config: ResolvedConfig, options: StartOptions): ResolvedConfig {
  const wantHttp = options.http === true || config.gateway?.transport === 'http';
  if (!wantHttp) {
    if (options.port !== undefined) {
      process.stderr.write(
        '\x1b[33m[cordon] --port has no effect without --http (or gateway config). Ignoring.\x1b[0m\n',
      );
    }
    return config;
  }

  const httpConfig = config.gateway?.transport === 'http' ? config.gateway : undefined;
  const authToken = httpConfig?.authToken ?? process.env.CORDON_GATEWAY_TOKEN;

  if (!authToken) {
    process.stderr.write(
      '\x1b[31merror\x1b[0m: HTTP transport requires an auth token.\n' +
      '  Set `gateway: { transport: "http", authToken: process.env.CORDON_GATEWAY_TOKEN }` in\n' +
      '  cordon.config.ts, or export `CORDON_GATEWAY_TOKEN` before running `cordon start --http`.\n',
    );
    process.exit(1);
  }

  return {
    ...config,
    gateway: {
      transport: 'http',
      authToken,
      ...(options.port !== undefined ? { port: options.port } : httpConfig?.port !== undefined ? { port: httpConfig.port } : {}),
      ...(httpConfig?.host !== undefined ? { host: httpConfig.host } : {}),
    },
  };
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
  // registry, fresh `npx -y @getcordon/cli start`) succeed instead of crashing.
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
  config = applyHttpFlags(config, options);

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
