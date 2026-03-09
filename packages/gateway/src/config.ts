import { z } from "zod";

const Env = z.object({
  REAL_MCP_SERVER:          z.string().url().default("http://localhost:8001"),
  CORDON_OPA_URL:           z.string().url().optional(),
  CORDON_DB:                z.string().default("cordon_audit.db"),
  DATABASE_URL:             z.string().optional(),
  CORDON_REDACT_PII:        z.coerce.boolean().default(true),
  CORDON_RATE_LIMIT:        z.coerce.number().int().min(0).default(60),
  CORDON_RATE_WINDOW:       z.coerce.number().int().min(1).default(60),
  CORDON_WEBHOOK_URL:       z.string().url().optional(),
  CORDON_ALERT_ON_BLOCK:    z.coerce.boolean().default(true),
  CORDON_ALERT_QUEUE_THRESHOLD: z.coerce.number().int().min(0).default(5),
  CORDON_DASHBOARD_KEY:     z.string().default(""),
  CORDON_SESSION_SECRET:    z.string().min(1).default(() => {
    console.warn("[CORDON] CORDON_SESSION_SECRET not set — using ephemeral key (not restart-safe)");
    return crypto.randomUUID();
  }),
  CORDON_OIDC_ISSUER:       z.string().optional(),
  CORDON_OIDC_CLIENT_ID:    z.string().optional(),
  CORDON_OIDC_CLIENT_SECRET: z.string().optional(),
  CORDON_OIDC_REDIRECT_URI: z.string().url().optional(),
  CORDON_OIDC_SCOPES:       z.string().default("openid email profile"),
  PORT:                     z.coerce.number().int().default(8000),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  console.error("[CORDON] Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

export const oidcEnabled =
  !!(config.CORDON_OIDC_ISSUER && config.CORDON_OIDC_CLIENT_ID && config.CORDON_OIDC_CLIENT_SECRET);
