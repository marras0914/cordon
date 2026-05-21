import { defineConfig } from "@getcordon/policy";
import { homedir } from "node:os";
import { join } from "node:path";

// Override at install time via the CORDON_FILESYSTEM_DIR user_config field in
// manifest.json. Defaults to the user's Documents folder.
const filesystemDir = process.env.CORDON_FILESYSTEM_DIR ?? join(homedir(), "Documents");

export default defineConfig({
  agentId: "smithery-default",

  servers: [
    {
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", filesystemDir],
      // Pass-through with full audit. To gate writes or specific tools, swap
      // this config for your own with policy 'approve-writes' and a Slack
      // approval channel. See getcordon.com for examples.
      policy: "allow",
    },
  ],

  audit: {
    enabled: true,
    // 'auto' resolves to 'stdout' until the user runs `cordon login` in a
    // separate terminal, at which point it upgrades to hosted streaming on
    // app.getcordon.com automatically on the next gateway start.
    output: "auto",
  },
});
