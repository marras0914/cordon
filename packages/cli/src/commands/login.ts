import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setAuth } from '../cli-state.js';

const DEFAULT_ENDPOINT = 'https://cordon-server-production.up.railway.app';
const PORT_RANGE = [53247, 53249, 53251] as const;
const TIMEOUT_MS = 5 * 60 * 1000;

interface LoginOptions {
  endpoint?: string;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* swallow — caller has already printed the URL for manual paste */ }
}

interface CallbackResult {
  token: string;
  state: string;
  signup: string;
}

async function listenForCallback(port: number, expectedState: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== '/cb') {
        res.writeHead(404).end('not found');
        return;
      }
      const token = url.searchParams.get('token') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const signup = url.searchParams.get('signup') ?? 'false';

      if (state !== expectedState || !token) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
          .end('<html><body><h2>Login failed</h2><p>State mismatch or missing token. You can close this tab.</p></body></html>');
        server.close();
        reject(new Error('Callback state mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' })
        .end('<html><body style="font-family:system-ui;padding:40px;"><h2>Logged in to Cordon for MCP</h2><p>You can close this tab and return to your terminal.</p></body></html>');
      server.close();
      resolve({ token, state, signup });
    });

    server.listen(port, '127.0.0.1');
    server.on('error', (err) => reject(err));

    setTimeout(() => {
      server.close();
      reject(new Error('Login timed out after 5 minutes'));
    }, TIMEOUT_MS).unref();
  });
}

export async function loginCommand(options: LoginOptions = {}): Promise<void> {
  const endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
  const state = randomBytes(16).toString('hex');

  let port: number | null = null;
  let result: CallbackResult | null = null;
  let lastErr: unknown = null;

  for (const candidate of PORT_RANGE) {
    try {
      const callback = `http://localhost:${candidate}/cb`;
      const authUrl =
        `${endpoint}/auth/cli/start?callback=${encodeURIComponent(callback)}&state=${state}`;

      process.stderr.write(
        `\n[cordon] opening browser to log in...\n` +
        `[cordon] if it doesn't open, visit:\n  ${authUrl}\n\n`,
      );
      openBrowser(authUrl);

      const pending = listenForCallback(candidate, state);
      port = candidate;
      result = await pending;
      break;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') continue;
      throw err;
    }
  }

  if (!result) {
    throw lastErr instanceof Error ? lastErr : new Error('Could not bind a local callback port');
  }

  setAuth({
    endpoint,
    apiKey: result.token,
    loggedInAt: new Date().toISOString(),
  });

  process.stderr.write(`\x1b[32m✓\x1b[0m logged in. API key saved to ~/.cordon/auth.json\n`);
  if (result.signup === 'true') {
    process.stderr.write(`Welcome to Cordon for MCP. Run \x1b[36mcordon init\x1b[0m next to wire up your MCP servers.\n`);
  }
  // Suppress unused var warning when port is set but not otherwise used
  void port;
}
