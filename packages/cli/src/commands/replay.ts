import { createInterface } from 'node:readline';
import { UpstreamManager, AuditLogger } from '@getcordon/core';
import { getAuth } from '../cli-state.js';
import { findConfigPath, loadConfig } from '../config-loader.js';

interface ReplayOptions {
  config?: string;
  endpoint?: string;
  yes?: boolean;
}

// The full approval record returned by GET /approvals/:callId.
interface ApprovalRecord {
  status: string;
  approvedBy: string | null;
  serverName: string | null;
  toolName: string | null;
  args: unknown;
  resolvedLate: boolean;
  expiresAt: string | null;
}

function fail(msg: string): never {
  process.stderr.write(`\x1b[31merror\x1b[0m: ${msg}\n`);
  process.exit(1);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // non-interactive without --yes = decline
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const t = answer.trim().toLowerCase();
      resolve(t === 'y' || t === 'yes');
    });
  });
}

/**
 * `cordon replay <callId>` — re-execute a tool call that was approved AFTER it
 * timed out (durable-context Phase 2). Cordon can recover the tool *call*; it
 * does not resume the agent's session. Guardrailed to approved-late records so a
 * call that already ran can't be double-executed.
 */
export async function replayCommand(callId: string, options: ReplayOptions): Promise<void> {
  const auth = getAuth();
  if (!auth) fail('not logged in. Run `cordon login` first.');
  const endpoint = (options.endpoint ?? auth.endpoint).replace(/\/$/, '');

  // 1. Fetch the approval record from cordon-server.
  const res = await fetch(`${endpoint}/approvals/${encodeURIComponent(callId)}`, {
    headers: { 'X-Cordon-Key': auth.apiKey },
  });
  if (res.status === 404) fail(`no approval found for callId '${callId}' on this account.`);
  if (!res.ok) fail(`failed to fetch approval: HTTP ${res.status}`);
  const record = (await res.json()) as ApprovalRecord;

  // 2. Guardrail: only a call approved AFTER timing out is safe to replay — it
  //    never actually ran. A normally-approved/denied/pending call must not be
  //    re-executed (double-run / not authorized).
  if (!(record.status === 'approved' && record.resolvedLate)) {
    fail(
      `call '${callId}' is not replayable (status=${record.status}, resolvedLate=${record.resolvedLate}). ` +
        `Only a call approved AFTER it timed out can be replayed — replaying anything else would double-execute or run an unauthorized call.`,
    );
  }
  if (!record.serverName || !record.toolName) {
    fail(`approval '${callId}' is missing server/tool info; cannot replay.`);
  }

  // 3. Load config + find the upstream server the call belongs to.
  const config = await loadConfig(await findConfigPath(options.config));
  const server = config.servers.find((s) => s.name === record.serverName);
  if (!server) {
    fail(`server '${record.serverName}' is not in your cordon.config.ts. Add it (or pass --config) and retry.`);
  }

  // 4. Confirm — replaying re-runs the tool, which can have side effects.
  process.stderr.write(
    `\nReplay this late-approved call?\n` +
      `  server : ${record.serverName}\n` +
      `  tool   : ${record.toolName}\n` +
      `  args   : ${JSON.stringify(record.args)}\n` +
      `  approved by ${record.approvedBy ?? 'unknown'} (after timeout)\n\n` +
      `This re-executes the tool. Non-idempotent tools have real side effects.\n`,
  );
  if (!options.yes) {
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) {
      process.stderr.write('[cordon] replay cancelled.\n');
      return;
    }
  }

  // 5. Execute against just this upstream (no gateway/transport, no policy loop —
  //    this is a human-authorized recovery, so it bypasses re-approval).
  const mgr = new UpstreamManager([server]);
  const started = Date.now();
  let isError = false;
  try {
    await mgr.connect();
    const result = await mgr.callTool(record.serverName, record.toolName, record.args);
    isError = Boolean((result as { isError?: boolean }).isError);
    process.stderr.write(
      `[cordon] replay ${isError ? 'returned an error' : 'succeeded'} in ${Date.now() - started}ms\n`,
    );
  } catch (e) {
    isError = true;
    process.stderr.write(`[cordon] replay failed: ${String(e)}\n`);
  } finally {
    await mgr.disconnect().catch(() => {});
  }

  // 6. Log the outcome to the hosted audit — same stream/dashboard as the gateway.
  //    HostedAuditOutput batches, so close() is required or the event is lost.
  const audit = new AuditLogger({ enabled: true, output: 'hosted', endpoint, apiKey: auth.apiKey });
  audit.log({
    event: isError ? 'tool_call_errored' : 'tool_call_completed',
    callId,
    serverName: record.serverName,
    toolName: record.toolName,
    args: record.args,
    isError,
    durationMs: Date.now() - started,
    reason: 'replay of late-approved call',
  });
  audit.close();

  // 7. On success, dismiss the record so it leaves the recoverable list (the
  //    replay now lives in the audit stream). On error, leave it to retry.
  if (!isError) {
    await fetch(`${endpoint}/approvals/${encodeURIComponent(callId)}`, {
      method: 'DELETE',
      headers: { 'X-Cordon-Key': auth.apiKey },
    }).catch(() => {});
    process.stderr.write('[cordon] logged to the dashboard and cleared from recoverable.\n');
  } else {
    process.stderr.write('[cordon] left in the recoverable list so you can retry.\n');
  }
}
