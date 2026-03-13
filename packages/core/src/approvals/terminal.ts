import { createInterface, Interface } from 'node:readline';
import { createReadStream } from 'node:fs';
import type { ApprovalContext, ApprovalResult } from './manager.js';

/**
 * Terminal approval channel.
 *
 * IMPORTANT: The MCP stdio transport owns process.stdin and process.stdout.
 * Writing to stdout or reading from stdin will corrupt the JSON-RPC stream.
 * We must:
 *   - Write prompts to process.stderr
 *   - Read input directly from the TTY device (/dev/tty on Unix, \\.\CONIN$ on Windows)
 *
 * A singleton readline interface is used so that \\.\CONIN$ is only opened
 * once per process — re-opening it on Windows causes subsequent reads to
 * get immediate EOF.
 */

// Singleton readline interface — created lazily, reused across all approval requests.
let sharedRl: Interface | null = null;
const lineResolvers: Array<(line: string) => void> = [];

function getSharedRl(): Interface {
  if (sharedRl) return sharedRl;

  const ttyPath = process.platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty';
  const stream = createReadStream(ttyPath);
  sharedRl = createInterface({ input: stream, terminal: false });

  sharedRl.on('line', (line) => {
    const resolver = lineResolvers.shift();
    if (resolver) resolver(line);
  });

  sharedRl.on('close', () => {
    sharedRl = null;
    // Drain any waiting resolvers with an empty line (will be treated as deny)
    for (const resolver of lineResolvers.splice(0)) {
      resolver('');
    }
  });

  return sharedRl;
}

export class TerminalApprovalChannel {
  async request(ctx: ApprovalContext): Promise<ApprovalResult> {
    const argsDisplay = JSON.stringify(ctx.args, null, 2)
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');

    process.stderr.write(
      `\n\x1b[33m╔══════════════════════════════════════╗\x1b[0m\n` +
        `\x1b[33m║  ⚠  APPROVAL REQUIRED               ║\x1b[0m\n` +
        `\x1b[33m╚══════════════════════════════════════╝\x1b[0m\n` +
        `  Server : \x1b[36m${ctx.serverName}\x1b[0m\n` +
        `  Tool   : \x1b[36m${ctx.toolName}\x1b[0m\n` +
        `  Args   :\n${argsDisplay}\n\n` +
        `  \x1b[32m[A]\x1b[0mppove  \x1b[31m[D]\x1b[0meny\n` +
        `  > `,
    );

    return new Promise((resolve) => {
      let settled = false;

      const lineResolver = (line: string) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);

        const input = line.trim().toLowerCase();
        if (input === 'a' || input === 'approve' || input === 'yes' || input === 'y') {
          process.stderr.write('  \x1b[32mApproved.\x1b[0m\n\n');
          resolve({ approved: true });
        } else {
          process.stderr.write('  \x1b[31mDenied.\x1b[0m\n\n');
          resolve({ approved: false, reason: 'Denied by operator' });
        }
      };

      const timeoutHandle =
        ctx.timeoutMs !== undefined
          ? setTimeout(() => {
              if (settled) return;
              settled = true;
              const idx = lineResolvers.indexOf(lineResolver);
              if (idx !== -1) lineResolvers.splice(idx, 1);
              process.stderr.write('\n  \x1b[31mAuto-denied: approval timeout\x1b[0m\n\n');
              resolve({ approved: false, reason: 'Approval timed out' });
            }, ctx.timeoutMs)
          : null;

      try {
        lineResolvers.push(lineResolver);
        getSharedRl(); // ensure the interface is running
      } catch {
        lineResolvers.splice(lineResolvers.indexOf(lineResolver), 1);
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        process.stderr.write(
          `  \x1b[31mWarning: no TTY available for approval — auto-denying.\x1b[0m\n`,
        );
        resolve({ approved: false, reason: 'No TTY available for approval' });
      }
    });
  }
}
