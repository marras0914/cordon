import { defineConfig } from 'cordon-sdk';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to this config file, not the process CWD
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  servers: [
    {
      name: 'demo-db',
      transport: 'stdio',
      command: 'npx',
      args: ['tsx', join(__dirname, 'dangerous-server.ts')],

      // Default policy for all tools: require approval for writes,
      // let reads pass through automatically.
      policy: 'approve-writes',

      // Per-tool overrides — these take precedence over the server policy.
      tools: {
        drop_table: {
          action: 'block',
          reason: 'Dropping tables is never permitted. Use a migration script.',
        },
        delete_file: {
          action: 'block',
          reason: 'File deletion requires a manual ops process, not an agent.',
        },
      },
    },
  ],

  audit: {
    enabled: true,
    output: ['stdout', 'file'],
    filePath: join(__dirname, 'cordon-audit.log'),
  },

  approvals: {
    channel: 'terminal',
    timeoutMs: 30_000,
  },
});
