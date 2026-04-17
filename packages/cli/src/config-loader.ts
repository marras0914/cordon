import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createJiti } from 'jiti';
import type { CordonConfig, ResolvedConfig } from 'cordon-sdk';

const SEARCH_PATHS = [
  () => join(process.cwd(), 'cordon.config.ts'),
  () => join(process.cwd(), 'cordon.config.js'),
  () => join(homedir(), '.cordon', 'config.ts'),
  () => join(homedir(), '.cordon', 'config.js'),
];

export async function findConfigPath(explicit?: string): Promise<string> {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`Config file not found: ${explicit}`);
    }
    return explicit;
  }

  for (const candidate of SEARCH_PATHS) {
    const p = candidate();
    if (existsSync(p)) return p;
  }

  throw new Error(
    'No cordon config found. Run `cordon init` to create one, or pass --config <path>.',
  );
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  // jiti handles TypeScript config files without requiring a separate compile step
  const jiti = createJiti(import.meta.url);
  const mod = await jiti.import(configPath);

  const raw = (mod as { default?: CordonConfig }).default ?? (mod as CordonConfig);

  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.servers)) {
    throw new Error(
      `Invalid config at ${configPath}: expected an object with a 'servers' array. ` +
        `Make sure you are using \`export default defineConfig({...})\`.`,
    );
  }

  return applyDefaults(raw as CordonConfig);
}

function applyDefaults(config: CordonConfig): ResolvedConfig {
  return {
    ...config,
    audit: config.audit ?? { enabled: true, output: 'stdout' },
    approvals: config.approvals ?? { channel: 'terminal' },
  };
}

export function emptyConfig(): ResolvedConfig {
  return applyDefaults({ servers: [] });
}
