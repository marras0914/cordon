import { defineConfig } from "cordon-sdk";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve paths relative to this config file, not the process CWD
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Optional identity for this Cordon process. Surfaced in audit logs and
  // intended (with HTTP/SSE transport, coming next) to scope policies per
  // agent on a multi-agent gateway. In stdio mode, one process == one agent.
  agentId: "showcase-agent",

  servers: [
    {
      name: "demo-db",
      transport: "stdio",
      command: "npx",
      args: ["tsx", join(__dirname, "dangerous-server.ts")],

      // Default policy for all tools: require approval for writes,
      // let reads pass through automatically.
      policy: "approve-writes",

      // Per-tool overrides — these take precedence over the server policy.
      tools: {
        drop_table: {
          action: "block",
          reason: "Dropping tables is never permitted. Use a migration script.",
        },
        delete_file: {
          action: "block",
          reason: "File deletion requires a manual ops process, not an agent.",
        },
      },
    },
  ],

  // Call-graph rules — applied additively on top of per-tool policies.
  // A rule only takes effect when its action raises severity over the base
  // (severity: allow < approve < block). Multi-rule matches resolve by
  // highest severity.
  callGraph: [
    {
      // Classic exfil shape: read sensitive data, then write it to disk
      // (or to anywhere a write_* tool could send it). Even though
      // write_file already requires approval under approve-writes, this
      // rule blocks the *sequence* outright — a stricter ratchet on the
      // approval workflow.
      from: "read_data",
      to: "write_file",
      action: "block",
      reason: "No file writes after database reads — exfil-shaped.",
    },
  ],

  audit: {
    enabled: true,
    output: ["stdout", "file", "hosted"],
    filePath: join(__dirname, "cordon-audit.log"),
    endpoint: "https://app.getcordon.com",
    apiKey: "crd_add6ef3ab2f04f62947667c5548f27df",
  },

  approvals: {
    channel: "slack",
    slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
    slackChannel: "#cordon-approvals",
    endpoint: "https://app.getcordon.com",
    apiKey: "crd_add6ef3ab2f04f62947667c5548f27df",
    timeoutMs: 60_000,
  },
});
