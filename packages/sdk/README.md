# cordon-sdk

TypeScript SDK for configuring [Cordon](https://github.com/marras0914/cordon), the security gateway for MCP tool calls.

This package exports `defineConfig` and the config type surface. You only need it if you're writing a `cordon.config.ts` file.

## Install

```bash
npm install cordon-sdk
```

`cordon init` (from the `cordon-cli` package) installs this automatically into your project.

## Usage

```typescript
import { defineConfig } from 'cordon-sdk';

export default defineConfig({
  servers: [
    {
      name: 'database',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', process.env.POSTGRES_URL!],
      policy: 'read-only',
    },
    {
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      policy: 'approve-writes',
      tools: {
        delete_repository: 'block',
        create_pull_request: 'approve',
      },
    },
  ],

  audit: {
    enabled: true,
    output: 'file',       // 'stdout' | 'file' | 'hosted'
  },

  approvals: {
    channel: 'terminal',  // 'terminal' | 'slack'
    timeoutMs: 60_000,
  },

  rateLimit: {
    perServerPerMinute: 60,
  },
});
```

## Policy actions

| Policy | Behavior |
|---|---|
| `allow` | Pass through immediately |
| `block` | Reject with an error |
| `approve` | Pause the agent, prompt for human approval |
| `approve-writes` | Reads pass through, writes require approval |
| `read-only` | Writes are blocked, reads pass through |
| `log-only` | Pass through, flagged in audit log |

Policies can be set at the server level or per-tool. Per-tool overrides the server default.

## Full documentation

Complete reference including all config fields, approval channels, and audit outputs:
**https://github.com/marras0914/cordon**

## License

MIT
