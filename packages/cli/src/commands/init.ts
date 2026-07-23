import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { setState, getAuth } from '../cli-state.js';
import { loginCommand } from './login.js';

const DASHBOARD_URL = 'https://app.getcordon.com/dashboard/';

function ensureCordonSdkInstalled(cwd: string): void {
  // Config imports from '@getcordon/policy', and jiti resolves it from the config
  // file's directory. Without a local install, `cordon start` dies with
  // "Cannot find module '@getcordon/policy'" even when the CLI is global.
  if (existsSync(join(cwd, 'node_modules', '@getcordon/policy', 'package.json'))) {
    return;
  }

  if (!existsSync(join(cwd, 'package.json'))) {
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'cordon-config', version: '0.0.0', private: true }, null, 2) + '\n',
      'utf8',
    );
    process.stderr.write(`\x1b[32m✓\x1b[0m created package.json\n`);
  }

  process.stderr.write(`[cordon] installing @getcordon/policy...\n`);
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['install', '@getcordon/policy'], {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  if (result.status === 0) {
    process.stderr.write(`\x1b[32m✓\x1b[0m installed @getcordon/policy\n`);
  } else {
    process.stderr.write(
      `\x1b[33mwarn\x1b[0m: could not auto-install @getcordon/policy. ` +
        `Run 'npm install @getcordon/policy' in this directory before 'cordon start'.\n`,
    );
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  // Non-interactive (CI, piped stdin): skip rather than surprise the operator
  // with a browser tab and a 5-minute callback timeout.
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const trimmed = answer.trim().toLowerCase();
      // Empty = default Yes
      resolve(trimmed === '' || trimmed === 'y' || trimmed === 'yes');
    });
  });
}

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
      name: ${JSON.stringify(name)},
      transport: 'stdio',
      command: ${JSON.stringify(cfg.command)}${argsStr}${envStr},
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

  let auth = getAuth();
  let promptShown = false;
  if (!auth && process.stdin.isTTY) {
    promptShown = true;
    process.stderr.write(
      `\n\x1b[36mCordon works locally out of the box.\x1b[0m ` +
        `Sign in to enable hosted audit logs + Slack approvals (free).\n`,
    );
    const wantsLogin = await promptYesNo('Sign in via browser now? [Y/n] ');
    if (wantsLogin) {
      try {
        await loginCommand();
        auth = getAuth();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        process.stderr.write(
          `\x1b[33mwarn\x1b[0m: login didn't complete (${msg}). ` +
            `Continuing with local stdout audit. Run \x1b[36mcordon login\x1b[0m later.\n`,
        );
      }
    }
  }

  const auditBlock = auth
    ? `audit: {
    enabled: true,
    output: 'hosted',
    // endpoint + apiKey are auto-loaded from ~/.cordon/auth.json (cordon login)
  },`
    : `audit: {
    enabled: true,
    // 'auto' streams to stdout until you run \`cordon login\`, then auto-switches to hosted.
    output: 'auto',
  },`;

  const approvalsBlock = auth
    ? `approvals: {
    // Human-in-the-loop over Slack. Connect your workspace once via
    // "Add to Slack" in the dashboard — endpoint + apiKey are auto-loaded.
    channel: 'slack',
    // timeoutMs: 60_000,
  },`
    : `approvals: {
    channel: 'terminal',
    // timeoutMs: 60_000,
  },`;

  const content = `import { defineConfig } from '@getcordon/policy';

export default defineConfig({
  servers: [
${serverBlocks}
  ],

  ${auditBlock}

  ${approvalsBlock}
});
`;

  writeFileSync(outputPath, content, 'utf8');
  process.stderr.write(`\x1b[32m✓\x1b[0m wrote cordon.config.ts\n`);

  // The config imports from '@getcordon/policy'. Install it locally so jiti can
  // resolve it when `cordon start` runs.
  ensureCordonSdkInstalled(process.cwd());

  // Patch Claude Desktop config to route through cordon.
  //
  // We bind the spawn to the *exact* node + cordon.js paths that ran this
  // init. Earlier versions wrote `npx.cmd` (or `npx`), which relies on
  // PATH lookup at spawn time. Claude Desktop's spawned subprocesses
  // inherit a stripped PATH on Windows that often lacks the user's
  // nvm/Node bin dir, so `npx.cmd` fails with "is not recognized as an
  // internal or external command". Using full paths skips PATH and the
  // cmd.exe wrapper entirely.
  if (claudePath && servers.length > 0) {
    const cordonConfigPath = outputPath.replace(/\\/g, '/');
    const nodePath = process.execPath.replace(/\\/g, '/');
    const cordonScriptPath = (process.argv[1] ?? '').replace(/\\/g, '/');

    if (!cordonScriptPath) {
      process.stderr.write(
        `\x1b[33mwarn\x1b[0m: could not detect cordon CLI script path. ` +
          `Skipping Claude Desktop patch.\n` +
          `Manually add this to your claude_desktop_config.json mcpServers:\n` +
          `  "cordon": { "command": "${nodePath}", "args": ["<path-to-cordon.js>", "start", "--config", "${cordonConfigPath}"] }\n`,
      );
      return;
    }

    const newClaudeConfig: ClaudeDesktopConfig = {
      ...claudeConfig,
      mcpServers: {
        cordon: {
          command: nodePath,
          args: [cordonScriptPath, 'start', '--config', cordonConfigPath],
        },
      },
    };

    // Backup the original — only if no backup exists yet, so re-running init
    // never overwrites the user's true pre-cordon config.
    const backupPath = `${claudePath}.cordon-backup`;
    if (existsSync(backupPath)) {
      process.stderr.write(
        `[cordon] existing backup at ${backupPath} preserved (won't overwrite)\n`,
      );
    } else {
      writeFileSync(backupPath, readFileSync(claudePath, 'utf8'), 'utf8');
      process.stderr.write(`\x1b[32m✓\x1b[0m backed up Claude Desktop config to ${backupPath}\n`);
    }

    writeFileSync(claudePath, JSON.stringify(newClaudeConfig, null, 2), 'utf8');
    process.stderr.write(`\x1b[32m✓\x1b[0m patched Claude Desktop config\n`);
    process.stderr.write(
      `\n\x1b[36mRestart Claude Desktop to activate Cordon.\x1b[0m\n`,
    );
  } else if (!claudePath) {
    const nodePath = process.execPath.replace(/\\/g, '/');
    const cordonScriptPath = (process.argv[1] ?? '<path-to-cordon.js>').replace(/\\/g, '/');
    process.stderr.write(
      `\n\x1b[33mwarn\x1b[0m: Claude Desktop config not found on this system.\n` +
      `Edit cordon.config.ts, then manually add Cordon to your MCP client config:\n\n` +
      `  "mcpServers": {\n` +
      `    "cordon": {\n` +
      `      "command": "${nodePath}",\n` +
      `      "args": ["${cordonScriptPath}", "start", "--config", "${outputPath.replace(/\\/g, '/')}"]\n` +
      `    }\n` +
      `  }\n`,
    );
  } else {
    // claudePath found but no existing servers — config written, no patching needed
    process.stderr.write(
      `\nEdit cordon.config.ts to add your MCP servers, then run \x1b[36mnpx cordon start\x1b[0m.\n`,
    );
  }

  if (auth) {
    process.stderr.write(
      `\n\x1b[32m✓\x1b[0m audit logs will stream to your Cordon account (${auth.endpoint})\n`,
    );
  } else if (promptShown) {
    process.stderr.write(
      `\n[cordon] running in local mode. Run \x1b[36mcordon login\x1b[0m later to enable hosted audit.\n`,
    );
  } else {
    process.stderr.write(
      `\n\x1b[36mWant centralized audit logs + Slack approvals?\x1b[0m\n` +
      `Run \x1b[36mcordon login\x1b[0m to register a free account, ` +
      `or sign up at ${DASHBOARD_URL}?utm_source=cli_init\n`,
    );
  }
  setState({ welcomed: true });
}
