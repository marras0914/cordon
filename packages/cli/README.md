# @getcordon/cli

The command-line interface for [Cordon for MCP](https://github.com/marras0914/cordon), the security gateway for MCP tool calls.

## Install

```bash
npm install -g @getcordon/cli
```

## Quickstart

```bash
cordon init      # reads your Claude Desktop config, generates cordon.config.ts,
                 # patches Claude Desktop to route tool calls through Cordon
cordon start     # launches the gateway
```

Restart Claude Desktop after `cordon init`. Every MCP tool call now flows through Cordon.

## Commands

| Command | What it does |
|---|---|
| `cordon init` | Reads your Claude Desktop config, generates `cordon.config.ts`, patches the client to route through Cordon (backs up the original). Offers to sign you in inline. |
| `cordon start` | Launches the gateway. `--port <n>` serves HTTP/Streamable HTTP instead of stdio (default port 7777, path `/mcp`). |
| `cordon login` | Browser-based GitHub OAuth. Creates an API key and writes `~/.cordon/auth.json`, which enables the hosted dashboard, Slack approvals, and `replay`. |
| `cordon logout` | Removes the stored credentials. |
| `cordon replay <callId>` | Re-runs a tool call that was approved *after* it timed out. See below. |

### `cordon replay`

An approval that nobody answers in time is denied, and the agent moves on — but
the decision itself isn't lost. If someone approves the card late, the call
becomes replayable:

```bash
cordon replay 7f3c1a2e-...        # prompts for confirmation
cordon replay 7f3c1a2e-... --yes  # skip the prompt
```

It fetches the approval record, calls the tool on the upstream server, logs the
outcome to your audit stream with reason `replay of late-approved call`, and
clears the entry from the recoverable list. The dashboard shows the exact command
for any recoverable call under **What changed → Timed-out approvals**.

Two things worth knowing before you rely on it:

- **It replays the tool call, not the agent's session.** The agent that made the
  original request is long gone. You get the side effect the call would have had,
  not a resumed conversation.
- **Only a call approved after timing out can be replayed.** Anything else —
  pending, denied, or normally approved — is refused, because replaying a call
  that already ran would double-execute it and replaying a denied one would run
  something nobody authorized. Non-idempotent tools still have real side effects
  on replay, which is why it confirms first.

Requires `cordon login`, and the upstream server must still be present in your
`cordon.config.ts`.

## What it does

- Scans `claude_desktop_config.json` and generates a starter `cordon.config.ts`
- Patches your MCP client config to route through Cordon (opt-in, backed up)
- Runs the gateway as an MCP server that aggregates your existing upstream servers
- Enforces per-tool policies (allow, block, approve, read-only, log-only, hidden, sql-read-only, sql-approve-writes)
- Supports closed-world tool catalogs via `knownTools` so new upstream tools don't silently become callable
- SQL-aware policies parse the statement in tool-call args and decide based on type (SELECT vs DML vs DDL)
- Surfaces approval prompts in the terminal, or Slack via the hosted dashboard
- Retains approvals that timed out, so a late decision can still be acted on (`cordon replay`)

## Config example

```typescript
import { defineConfig } from '@getcordon/policy';

export default defineConfig({
  servers: [
    {
      name: 'database',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres', process.env.POSTGRES_URL!],
      policy: 'read-only',
      // Optional: declare the exact tool surface you expect. New tools in
      // future upstream releases get blocked until you add them here.
      knownTools: ['query', 'list_tables', 'describe_table'],
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
