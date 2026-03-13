import { createInterface } from 'node:readline';
import { openSync, createReadStream, createWriteStream } from 'node:fs';
import type { ApprovalContext, ApprovalResult } from './manager.js';

/**
 * Terminal approval channel.
 *
 * IMPORTANT: The MCP stdio transport owns process.stdin and process.stdout.
 * Writing to stdout or reading from stdin will corrupt the JSON-RPC stream.
 * We must:
 *   - Write prompts to process.stderr
 *   - Read input directly from the TTY device (/dev/tty on Unix, \\.\CONIN$ on Windows)
 */
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
      try {
        const ttyInput = openTtyInput();
        const rl = createInterface({ input: ttyInput, terminal: false });

        // Auto-deny on timeout if configured
        const timeoutHandle =
          ctx.timeoutMs !== undefined
            ? setTimeout(() => {
                rl.close();
                process.stderr.write('\n  \x1b[31mAuto-denied: approval timeout\x1b[0m\n\n');
                resolve({ approved: false, reason: 'Approval timed out' });
              }, ctx.timeoutMs)
            : null;

        let answered = false;

        rl.once('line', (line) => {
          answered = true;
          if (timeoutHandle) clearTimeout(timeoutHandle);

          const input = line.trim().toLowerCase();
          if (input === 'a' || input === 'approve' || input === 'yes' || input === 'y') {
            process.stderr.write('  \x1b[32mApproved.\x1b[0m\n\n');
            resolve({ approved: true });
          } else {
            process.stderr.write('  \x1b[31mDenied.\x1b[0m\n\n');
            resolve({ approved: false, reason: 'Denied by operator' });
          }
          rl.close();
        });

        // If the TTY closes without input (e.g. piped input exhausted), deny
        rl.once('close', () => {
          if (!answered) {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            resolve({ approved: false, reason: 'TTY closed before response' });
          }
        });
      } catch (err) {
        // If we can't open a TTY (e.g. running in CI with no terminal), auto-deny
        process.stderr.write(
          `  \x1b[31mWarning: no TTY available for approval — auto-denying.\x1b[0m\n`,
        );
        resolve({ approved: false, reason: 'No TTY available for approval' });
      }
    });
  }
}

/**
 * Opens the real TTY device for reading, bypassing stdin which is owned by
 * the MCP transport. Platform-aware.
 */
function openTtyInput(): NodeJS.ReadableStream {
  const ttyPath = process.platform === 'win32' ? '\\\\.\\CONIN$' : '/dev/tty';
  try {
    return createReadStream(ttyPath);
  } catch {
    throw new Error(`Cannot open TTY at ${ttyPath}`);
  }
}
