import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface CliState {
  welcomed?: boolean;
}

function statePath(): string {
  return join(homedir(), '.cordon', 'state.json');
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
  const path = statePath();
  const dir = join(homedir(), '.cordon');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const merged = { ...getState(), ...patch };
    writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8');
  } catch {
    // Non-fatal: missing state just means we re-show the banner next time.
  }
}
