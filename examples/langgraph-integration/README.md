# Securing LangGraph MCP Tool Calls with Cordon

A drop-in security layer between your LangGraph agent and any MCP server.
No changes to your LangGraph code. No changes to your MCP servers.

## What this adds

| Without Cordon | With Cordon |
|---|---|
| Agent calls any tool, any time | Sequence-aware policies block attack-shaped call graphs |
| No visibility into tool call payloads | Full audit log: every call, every arg, every decision |
| Write operations happen silently | Human-in-the-loop approval via terminal or Slack |
| `drop_table` is just another tool | Specific tools blocked at the config layer |

## Two integration modes

### stdio (local dev, single agent)
```
LangGraph MCPClient → cordon (stdio) → your MCP server
```

### HTTP / Streamable HTTP (team deployments, multi-agent)
```
LangGraph MCPClient → cordon (HTTP :7777/mcp) → your MCP servers
Multiple agents can share one Cordon gateway. Bearer token auth.
```

## Prerequisites

```bash
# Cordon CLI
npm install -g @getcordon/cli

# Python deps
pip install langgraph langchain-mcp-adapters langchain-anthropic
```

## 1. Create a Cordon config

```typescript
// cordon.config.ts
import { defineConfig } from '@getcordon/policy';

export default defineConfig({
  servers: [
    {
      name: 'my-db',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@my-org/db-mcp-server'],

      // Default policy: reads pass, writes pause for approval
      policy: 'approve-writes',

      // Per-tool overrides
      tools: {
        drop_table: {
          action: 'block',
          reason: 'Table drops require a migration script, not an agent.',
        },
        execute_raw_sql: 'sql-read-only', // parse SQL; block anything that isn't SELECT
      },

      // Closed-world: any tool NOT in this list is hidden from the LLM
      knownTools: ['read_data', 'execute_raw_sql', 'list_tables'],
    },
    {
      name: 'filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/agent-workspace'],
      policy: 'approve-writes',
    },
  ],

  // Sequence-aware rules — block the *shape* of attacks, not just individual tools.
  // Cordon tracks the call graph within an agent turn and matches these patterns.
  callGraph: [
    {
      // Classic exfil: read DB data, then write it to disk
      from: 'read_data',
      to: 'write_file',
      action: 'block',
      reason: 'Potential exfil — DB read followed by file write in the same turn.',
    },
  ],

  audit: {
    enabled: true,
    output: ['stdout', 'file'],
    filePath: './cordon-audit.log',
  },

  approvals: {
    // 'terminal' for local dev — pauses and prompts in the terminal
    // Switch to 'slack' for team deployments (see below)
    channel: 'terminal',
  },
});
```

## 2a. stdio mode (local dev)

Start Cordon and point LangGraph at it over stdio:

```bash
cordon start --config cordon.config.ts
```

```python
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic

async def main():
    async with MultiServerMCPClient(
        {
            "cordon": {
                "command": "cordon",
                "args": ["start", "--config", "cordon.config.ts"],
                "transport": "stdio",
            }
        }
    ) as client:
        tools = await client.get_tools()
        print(f"Tools through Cordon: {[t.name for t in tools]}")

        agent = create_react_agent(ChatAnthropic(model="claude-3-5-sonnet-20241022"), tools)
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": "What tables exist in the database?"}]}
        )
        print(result["messages"][-1].content)

asyncio.run(main())
```

## 2b. HTTP mode (team deployments, multi-agent)

For shared deployments — multiple agents, n8n workflows, or any non-stdio client.

Add gateway config:

```typescript
// cordon.config.ts
export default defineConfig({
  // ... servers, callGraph, audit, approvals as above ...

  gateway: {
    transport: 'http',
    port: 7777,
    host: '127.0.0.1',        // '0.0.0.0' to expose on the network
    authToken: process.env.CORDON_GATEWAY_TOKEN,
  },
});
```

Start with the `--http` flag:

```bash
CORDON_GATEWAY_TOKEN=your-secret cordon start --config cordon.config.ts --http
# [cordon] HTTP gateway listening on http://127.0.0.1:7777/mcp
```

Connect LangGraph via Streamable HTTP:

```python
import asyncio
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic

async def main():
    async with MultiServerMCPClient(
        {
            "cordon": {
                "url": "http://127.0.0.1:7777/mcp",
                "transport": "streamable_http",
                "headers": {"Authorization": "Bearer your-secret"},
            }
        }
    ) as client:
        tools = await client.get_tools()
        print(f"Tools through Cordon: {[t.name for t in tools]}")

        agent = create_react_agent(ChatAnthropic(model="claude-3-5-sonnet-20241022"), tools)
        result = await agent.ainvoke(
            {"messages": [{"role": "user", "content": "Summarize the customer table."}]}
        )
        print(result["messages"][-1].content)

asyncio.run(main())
```

HTTP mode supports concurrent sessions — multiple agents share one Cordon gateway,
each with independent call-graph tracking.

## What happens on a policy violation

**Blocked tool** (`drop_table`):
```
[cordon] BLOCK  my-db/drop_table
         reason: Table drops require a migration script, not an agent.
         args:   {"table": "users"}
```
The tool call returns an error to the LLM. The agent sees it can't do this and either
tries an alternative or tells the user.

**Approval required** (`write_file` after reading the DB — caught by callGraph rule):
```
[cordon] BLOCK  filesystem/write_file
         reason: Potential exfil — DB read followed by file write in the same turn.
```

**Approval required** (write tool, no callGraph match):
```
[cordon] APPROVAL REQUIRED  filesystem/write_file
         args: {"path": "/tmp/agent-workspace/output.csv", "content": "..."}

         Allow? [y/N]:
```
The LangGraph agent pauses mid-turn. You approve or deny. The agent continues.

## Sequence detection — what no other MCP gateway does

Cordon tracks the call graph *across tool calls within an agent turn* and matches patterns.

```
Turn 1: read_data("SELECT * FROM customers")  → ALLOW ✓  (reads pass under approve-writes)
Turn 2: write_file("/tmp/out.csv", <data>)    → BLOCK ✗
         reason: Potential exfil — DB read followed by file write in the same turn.
```

The `callGraph` rule ratchets `write_file` from "needs approval" to "hard block" because
of the preceding `read_data`. The shape of the attack is caught, not just the individual tool.

## Slack approvals for team deployments

```typescript
approvals: {
  channel: 'slack',
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackChannel: '#agent-approvals',
  endpoint: 'https://app.getcordon.com',
  apiKey: process.env.CORDON_API_KEY,
  timeoutMs: 300_000, // 5 min window
},
```

Blocked calls post an interactive Slack message. Your team approves or denies from Slack.
The agent resumes or fails gracefully with the denial reason.

## Audit log

Every tool call — allowed, blocked, or approved — is logged:

```json
{"event":"tool_call_received","callId":"a1b2c3d4","serverName":"my-db","toolName":"read_data","args":{"sql":"SELECT * FROM customers"},"previousTool":null,"ts":"2026-07-17T14:23:01.000Z"}
{"event":"tool_call_completed","callId":"a1b2c3d4","decision":"allow","durationMs":42}
{"event":"tool_call_received","callId":"e5f6g7h8","serverName":"filesystem","toolName":"write_file","previousTool":"read_data","ts":"2026-07-17T14:23:02.000Z"}
{"event":"tool_call_blocked","callId":"e5f6g7h8","reason":"Potential exfil — DB read followed by file write in the same turn."}
```

Stream to the [Cordon dashboard](https://app.getcordon.com), your SIEM, or keep local.

## Further reading

- [getcordon.com](https://getcordon.com)
- [Human-in-the-loop guide](https://getcordon.com/use-cases/human-in-the-loop)
- [GitHub](https://github.com/marras0914/cordon)

Questions or want a design-partner conversation for your team's deployment?
→ [partners@getcordon.com](mailto:partners@getcordon.com)
