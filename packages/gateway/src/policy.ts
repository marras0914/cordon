import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { config } from "./config.ts";

export type Action = "ALLOW" | "BLOCK" | "REQUIRE_APPROVAL";

export interface PolicyResult {
  action: Action;
  reason: string;
}

interface YamlPolicy {
  version: string;
  default_action: Action;
  rules: Array<{ tool: string; action: Action; reason?: string }>;
}

// ---------- YAML (hot-reloaded) ----------

function yamlPolicy(toolName: string): PolicyResult {
  const raw = readFileSync("policy.yaml", "utf8");
  const cfg = yaml.load(raw) as YamlPolicy;
  const rule = cfg.rules?.find((r) => r.tool === toolName);
  if (rule) return { action: rule.action, reason: rule.reason ?? "" };
  return { action: cfg.default_action ?? "ALLOW", reason: "" };
}

// ---------- OPA ----------

async function opaPolicy(
  toolName: string,
  args: Record<string, unknown>,
  clientIp?: string | null,
): Promise<PolicyResult> {
  const res = await fetch(`${config.CORDON_OPA_URL}/v1/data/cordon/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: { tool: toolName, arguments: args, client_ip: clientIp } }),
    signal: AbortSignal.timeout(2_000),
  });
  const body = (await res.json()) as { result?: { action?: string; reason?: string } };
  return {
    action: (body.result?.action ?? "ALLOW") as Action,
    reason: body.result?.reason ?? "",
  };
}

// ---------- public ----------

export async function evaluatePolicy(
  toolName: string,
  args: Record<string, unknown>,
  clientIp?: string | null,
): Promise<PolicyResult> {
  if (config.CORDON_OPA_URL) {
    try {
      return await opaPolicy(toolName, args, clientIp);
    } catch (err) {
      console.warn(`[CORDON] OPA unreachable (${err}), falling back to policy.yaml`);
    }
  }
  return yamlPolicy(toolName);
}
