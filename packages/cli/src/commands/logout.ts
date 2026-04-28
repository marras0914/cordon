import { clearAuth } from '../cli-state.js';

export function logoutCommand(): void {
  if (clearAuth()) {
    process.stderr.write(`\x1b[32m✓\x1b[0m logged out. ~/.cordon/auth.json removed\n`);
  } else {
    process.stderr.write(`[cordon] not logged in\n`);
  }
}
