import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface CliState {
  welcomed?: boolean;
}

export interface CliAuth {
  endpoint: string;
  apiKey: string;
  userLogin?: string;
  loggedInAt: string;
}

function cordonDir(): string {
  return join(homedir(), '.cordon');
}

function statePath(): string {
  return join(cordonDir(), 'state.json');
}

function authPath(): string {
  return join(cordonDir(), 'auth.json');
}

function ensureCordonDir(): void {
  const dir = cordonDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function getState(): CliState {
  const path = statePath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CliState;
  } catch {
    return {};
  }
}

export function setState(patch: CliState): void {
  try {
    ensureCordonDir();
    const merged = { ...getState(), ...patch };
    writeFileSync(statePath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch {
    // Non-fatal: missing state just means we re-show the banner next time.
  }
}

export function getAuth(): CliAuth | null {
  const path = authPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CliAuth;
  } catch {
    return null;
  }
}

export function setAuth(auth: CliAuth): void {
  ensureCordonDir();
  const path = authPath();
  writeFileSync(path, JSON.stringify(auth, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
}

export function clearAuth(): boolean {
  const path = authPath();
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}
