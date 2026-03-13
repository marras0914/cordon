import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
}

function getClaudeConfigPath(): string | null {
  const candidates: string[] = [];

  if (process.platform === 'darwin') {
    candidates.push(
      join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    candidates.push(join(appData, 'Claude', 'claude_desktop_config.json'));
  } else {
    candidates.push(join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'));
  }

  return candidates.find((p) => existsSync(p)) ?? null;
}

export async function initCommand(): Promise<void> {
  const outputPath = join(process.cwd(), 'cordon.config.ts');

  if (existsSync(outputPath)) {
    process.stderr.write(
      `\x1b[33mwarn\x1b[0m: cordon.config.ts already exists — not overwriting.\n`,
    );
    process.exit(1);
  }

  // Try to discover existing MCP servers from Claude Desktop config
  const claudePath = getClaudeConfigPath();
  let claudeConfig: ClaudeDesktopConfig = {};

  if (claudePath) {
    process.stderr.write(`[cordon] found Claude Desktop config at ${claudePath}\n`);
    try {
      claudeConfig = JSON.parse(readFileSync(claudePath, 'utf8')) as ClaudeDesktopConfig;
    } catch {
      process.stderr.write(`\x1b[33mwarn\x1b[0m: could not parse Claude Desktop config\n`);
    }
  } else {
    process.stderr.write(
      `[cordon] no Claude Desktop config found — generating a blank config\n`,
    );
  }

  const servers = Object.entries(claudeConfig.mcpServers ?? {});

  // Generate cordon.config.ts
  const serverBlocks = servers.length > 0
    ? servers
        .map(([name, cfg]) => {
          const argsStr = cfg.args?.length
            ? `, args: ${JSON.stringify(cfg.args)}`
            : '';
          const envStr =
            cfg.env && Object.keys(cfg.env).length
              ? `, env: ${JSON.stringify(cfg.env)}`
            : '';
          return `    {
      name: '${name}',
      transport: 'stdio',
      command: '${cfg.command}'${argsStr}${envStr},
      policy: 'allow',
      // tools: {
      //   execute: 'approve',
      //   delete:  'block',
      // },
    },`;
        })
        .join('\n')
    : `    // {
    //   name: 'my-server',
    //   transport: 'stdio',
    //   command: 'npx',
    //   args: ['-y', '@my-org/my-mcp-server'],
    //   policy: 'allow',
    // },`;

  const content = `import { defineConfig } from 'cordon-sdk';

export default defineConfig({
  servers: [
${serverBlocks}
  ],

  audit: {
    enabled: true,
    output: 'stdout',
  },

  approvals: {
    channel: 'terminal',
    // timeoutMs: 60_000,
  },
});
`;

  writeFileSync(outputPath, content, 'utf8');
  process.stderr.write(`\x1b[32m✓\x1b[0m wrote cordon.config.ts\n`);

  // Patch Claude Desktop config to route through cordon
  if (claudePath && servers.length > 0) {
    const cordonConfigPath = outputPath.replace(/\\/g, '/');

    const newClaudeConfig: ClaudeDesktopConfig = {
      ...claudeConfig,
      mcpServers: {
        cordon: {
          command: 'npx',
          args: ['cordon-cli', 'start', '--config', cordonConfigPath],
        },
      },
    };

    // Backup the original
    const backupPath = `${claudePath}.cordon-backup`;
    writeFileSync(backupPath, readFileSync(claudePath, 'utf8'), 'utf8');
    process.stderr.write(`\x1b[32m✓\x1b[0m backed up Claude Desktop config to ${backupPath}\n`);

    writeFileSync(claudePath, JSON.stringify(newClaudeConfig, null, 2), 'utf8');
    process.stderr.write(`\x1b[32m✓\x1b[0m patched Claude Desktop config\n`);
    process.stderr.write(
      `\n\x1b[36mRestart Claude Desktop to activate Cordon.\x1b[0m\n`,
    );
  } else {
    process.stderr.write(
      `\nEdit cordon.config.ts, then run \x1b[36mnpx cordon start\x1b[0m.\n`,
    );
  }
}
