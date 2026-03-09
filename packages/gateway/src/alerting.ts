import { config } from "./config.ts";

function slackPayload(text: string) {
  return { text };
}

async function post(payload: object) {
  if (!config.CORDON_WEBHOOK_URL) return;
  try {
    await fetch(config.CORDON_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.warn(`[CORDON] Alert webhook failed: ${err}`);
  }
}

function fire(payload: object) {
  // Non-blocking
  post(payload).catch(() => undefined);
}

export function onBlock(toolName: string, reason: string, clientIp?: string | null) {
  if (!config.CORDON_WEBHOOK_URL || !config.CORDON_ALERT_ON_BLOCK) return;
  const ipStr = clientIp ? ` from \`${clientIp}\`` : "";
  fire(slackPayload(
    `:no_entry: *Cordon blocked tool call*\nTool: \`${toolName}\`${ipStr}\nReason: ${reason}`
  ));
}

export function onApprovalQueued(toolName: string, pendingCount: number) {
  if (!config.CORDON_WEBHOOK_URL || !config.CORDON_ALERT_QUEUE_THRESHOLD) return;
  if (pendingCount < config.CORDON_ALERT_QUEUE_THRESHOLD) return;
  fire(slackPayload(
    `:warning: *Cordon approval queue has ${pendingCount} pending requests*\nLatest: \`${toolName}\` — operator action required.`
  ));
}
