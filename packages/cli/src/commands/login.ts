import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setAuth } from '../cli-state.js';

const DEFAULT_ENDPOINT = 'https://app.getcordon.com';
const PORT_RANGE = [53247, 53249, 53251] as const;
const TIMEOUT_MS = 5 * 60 * 1000;

interface LoginOptions {
  endpoint?: string;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  // On Windows, `cmd /c start "" <url>` runs through cmd.exe, which treats
  // `&` and `^` as shell metacharacters. Without escaping them, query strings
  // like `?callback=…&state=…` get truncated at the first `&`, breaking the
  // OAuth state hand-off. Replace `^` first so we don't double-escape new ^&.
  const safeUrl = process.platform === 'win32'
    ? url.replace(/\^/g, '^^').replace(/&/g, '^&')
    : url;
  const args = process.platform === 'win32' ? ['/c', 'start', '""', safeUrl] : [safeUrl];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* swallow — caller has already printed the URL for manual paste */ }
}

interface CallbackResult {
  token: string;
  state: string;
  signup: string;
}

function renderCallbackPage(kind: 'success' | 'error', heading: string, body: string): string {
  const accent = kind === 'success' ? '#14b8a6' : '#f87171';
  const accentBg = kind === 'success' ? 'rgba(20, 184, 166, 0.15)' : 'rgba(248, 113, 113, 0.15)';
  const mark = kind === 'success' ? '✓' : '✗';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${kind === 'success' ? 'Logged in' : 'Login failed'} — Cordon for MCP</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90' fill='%2314b8a6'>◈</text></svg>">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0d0d0d; color: #e8e8e8;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1rem;
    }
    .card {
      background: #161616; border: 1px solid #2a2a2a; border-radius: 16px;
      padding: 48px; max-width: 420px; width: 100%; text-align: center;
    }
    .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 1.75rem; }
    .icon { font-size: 1.4rem; color: #14b8a6; }
    .name { font-weight: 600; font-size: 16px; letter-spacing: -0.3px; white-space: nowrap; }
    .mark {
      width: 56px; height: 56px; border-radius: 50%;
      background: ${accentBg}; color: ${accent};
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 1.25rem; font-size: 28px; font-weight: 700;
    }
    h1 { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 0.6rem; }
    p { color: #888; font-size: 0.95rem; line-height: 1.5; }
    p + p { margin-top: 0.5rem; }
    code {
      background: rgba(255, 255, 255, 0.06); color: #e8e8e8;
      padding: 1px 6px; border-radius: 3px; font-size: 0.85em;
      font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    }
    .btn {
      display: inline-block;
      background: #14b8a6; color: #000;
      font-weight: 600; padding: 0.65rem 1.25rem;
      border-radius: 6px; text-decoration: none;
      margin-top: 1.25rem; transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .hint {
      margin-top: 1.75rem; padding-top: 1.5rem;
      border-top: 1px solid #2a2a2a; font-size: 0.85rem; color: #666;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <span class="icon">◈</span>
      <span class="name">Cordon for MCP</span>
    </div>
    <div class="mark">${mark}</div>
    <h1>${heading}</h1>
    ${body}
  </div>
</body>
</html>`;
}

async function listenForCallback(port: number, expectedState: string, dashboardUrl: string): Promise<CallbackResult> {
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
        const body =
          `<p>The login link didn't carry a valid token, or the security state didn't match.</p>` +
          `<p class="hint">Run <code>cordon login</code> again from your terminal. You can close this tab.</p>`;
        res.writeHead(400, { 'Content-Type': 'text/html' })
          .end(renderCallbackPage('error', "Login didn't complete", body));
        server.close();
        reject(new Error('Callback state mismatch'));
        return;
      }

      const body =
        `<p>Your API key is saved. Return to your terminal to continue,` +
        ` or jump straight to your dashboard.</p>` +
        `<a href="${dashboardUrl}" class="btn">Open dashboard →</a>` +
        `<p class="hint">You can close this tab.</p>`;
      res.writeHead(200, { 'Content-Type': 'text/html' })
        .end(renderCallbackPage('success', "You're logged in", body));
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

      const pending = listenForCallback(candidate, state, `${endpoint}/dashboard/`);
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
    process.stderr.write(
      `Welcome to Cordon for MCP.\n` +
      `Dashboard: \x1b[36m${endpoint}/dashboard/\x1b[0m\n` +
      `Run \x1b[36mcordon init\x1b[0m next to wire up your MCP servers.\n`,
    );
  }
  // Suppress unused var warning when port is set but not otherwise used
  void port;
}
