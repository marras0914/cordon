# cordon-cli

The command-line interface for [Cordon](https://github.com/marras0914/cordon), the security gateway for MCP tool calls.

## Install

```bash
npm install -g cordon-cli
```

## Quickstart

```bash
cordon init      # reads your Claude Desktop config, generates cordon.config.ts,
                 # patches Claude Desktop to route tool calls through Cordon
cordon start     # launches the gateway
```

Restart Claude Desktop after `cordon init`. Every MCP tool call now flows through Cordon.

## What it does

- Scans `claude_desktop_config.json` and generates a starter `cordon.config.ts`
- Patches your MCP client config to route through Cordon (opt-in, backed up)
- Runs the gateway as an MCP server that aggregates your existing upstream servers
- Enforces per-tool policies (allow, block, approve, read-only, log-only)
- Surfaces approval prompts in the terminal, or Slack via the hosted dashboard

## Config example

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
  ],
  audit: { enabled: true, output: 'file' },
  approvals: { channel: 'terminal', timeoutMs: 60_000 },
});
```

## Full documentation

Complete policy reference, approval channels, audit outputs, and architecture overview:
**https://github.com/marras0914/cordon**

Writeup with real-world examples:
**https://dev.to/marras0914/mcp-has-no-security-model-heres-how-to-fix-it-in-2-minutes-5f7o**

## License

MIT
