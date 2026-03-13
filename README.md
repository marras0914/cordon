<p align="center">
  <strong>Cordon</strong>
</p>

<h3 align="center">The Security Gateway for AI Agents</h3>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#why-cordon">Why Cordon</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#configuration">Configuration</a> •
  <a href="#roadmap">Roadmap</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/cordon-cli?style=flat-square&color=blue" alt="npm version" />
  <img src="https://img.shields.io/github/license/YOUR_USERNAME/cordon?style=flat-square" alt="license" />
  <img src="https://img.shields.io/github/stars/YOUR_USERNAME/cordon?style=flat-square" alt="stars" />
</p>

---

> Every company wants to deploy AI agents. No company is willing to give an agent the keys to their database.
>
> **Cordon closes the trust gap.**

---

## The Problem

The [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) has made it trivially easy to give AI agents access to powerful tools — databases, file systems, APIs, cloud infrastructure.

But MCP has **no built-in security model**. No audit logs. No approval workflows. No rate limits. Today, an AI agent is either **off** or **full admin**. There is nothing in between.

This is the single biggest blocker preventing AI agents from reaching production.

## The Solution

**Cordon is the security gateway that sits between the LLM and your MCP servers.**

It acts as a **firewall**, an **auditor**, and a **remote control** — giving you complete visibility and authority over what your AI agents can and cannot do.

```
┌─────────┐      ┌──────────┐      ┌──────────────┐
│  LLM /  │ ──▶  │  Cordon  │ ──▶  │  MCP Server  │
│  Agent  │ ◀──  │ Gateway  │ ◀──  │  (database,  │
└─────────┘      └──────────┘      │   fs, APIs)  │
                   │               └──────────────┘
                   ├── Policy Engine
                   ├── Audit Logger
                   └── Approval Workflows
```

No infrastructure changes. No rewrites. One config file.

---

## Quickstart

**Step 1 — Initialize**

Run this inside your project (where your `claude_desktop_config.json` exists):

```bash
npx cordon-cli init
```

This reads your existing Claude Desktop MCP config, generates `cordon.config.ts`, and patches Claude Desktop to route all tool calls through Cordon.

**Step 2 — Start**

```bash
npx cordon-cli start
```

Cordon starts, connects to your MCP servers, and begins intercepting tool calls. Restart Claude Desktop and every tool call now flows through the gateway.

### Manual setup

If you prefer to configure manually, install globally and create a config:

```bash
npm install -g cordon-cli
cordon init
```

`cordon init` generates a `cordon.config.ts`:

```typescript
import { defineConfig } from 'cordon-sdk';

export default defineConfig({
  servers: [
    {
      name: 'database',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@my-org/db-mcp-server'],
      policy: 'read-only',        // Block all write operations
    },
    {
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      policy: 'approve-writes',   // Reads pass; writes require approval
      tools: {
        delete_branch: 'block',   // Never, regardless of approval
      },
    },
  ],

  audit: {
    enabled: true,
    output: 'stdout',             // or 'file'
  },

  approvals: {
    channel: 'terminal',
    timeoutMs: 60_000,            // auto-deny after 60s if no response
  },
});
```

---

## Why Cordon

| Without Cordon | With Cordon |
|---|---|
| Agent has unrestricted tool access | Granular per-tool policies |
| No visibility into what agents did | Structured audit trail of every call |
| "Did the agent just drop a table?" | Real-time terminal approvals |
| Reads and writes treated the same | `approve-writes` lets reads through automatically |
| Compliance team says no to AI | Audit logs ready for export |

---

## Features

### Policy Engine

Define rules per tool, per server, or globally. Tool-level policies override server policies.

```typescript
// Server-level default
policy: 'approve-writes',

// Per-tool overrides
tools: {
  query:        'allow',    // reads: pass through
  execute:      'approve',  // writes: pause for human approval
  drop_table:   'block',    // catastrophic: always reject
  list_tables:  'log-only', // audit but don't interrupt
},
```

### Human-in-the-Loop Approvals

When a tool call requires approval, Cordon pauses the agent and prompts you directly in your terminal:

```
╔══════════════════════════════════════╗
║  ⚠  APPROVAL REQUIRED               ║
╚══════════════════════════════════════╝
  Server : database
  Tool   : execute_sql
  Args   :
  {
    "query": "DELETE FROM sessions WHERE expires_at < NOW()"
  }

  [A]pprove  [D]eny
  >
```

The agent waits. You decide.

### Audit Logging

Every tool call is logged as structured JSON — the request, the policy decision, the response, and timing. Pipe to stdout or write to a file for your compliance team.

```json
{"event":"tool_call_received","callId":"...","serverName":"database","toolName":"execute_sql","timestamp":1773434469641}
{"event":"approval_requested","callId":"...","serverName":"database","toolName":"execute_sql","timestamp":1773434469641}
{"event":"tool_call_approved","callId":"...","serverName":"database","toolName":"execute_sql","timestamp":1773434471203}
{"event":"tool_call_completed","callId":"...","durationMs":34,"isError":false,"timestamp":1773434471237}
```

### Read-Only Mode

One policy setting to block all write operations across a server. Zero guesswork about what counts as a write — Cordon detects it from the tool name.

```typescript
policy: 'read-only'  // any tool starting with write/create/update/delete/drop/execute/... is blocked
```

---

## How It Works

Cordon runs as a single **aggregating MCP proxy**. Instead of Claude Desktop connecting directly to your MCP servers, it connects to Cordon. Cordon then manages your servers internally.

```
Before:  Claude ──▶ MCP Server A (full access)
         Claude ──▶ MCP Server B (full access)

After:   Claude ──▶ Cordon ──▶ MCP Server A (governed)
                          ──▶ MCP Server B (governed)
```

Your LLM client and MCP servers don't change at all. `cordon init` handles the config patching.

---

## Configuration

### Policy actions

| Policy | Behavior |
|---|---|
| `allow` | Pass through immediately |
| `block` | Reject — agent receives an error |
| `approve` | Pause pending human approval in terminal |
| `approve-writes` | Reads pass through; writes require approval |
| `read-only` | All write operations are blocked |
| `log-only` | Pass through but flagged in the audit log |

Policies can be set at the server level (default for all tools) or per-tool (overrides the server default):

```typescript
{
  name: 'my-server',
  policy: 'approve-writes',   // server default
  tools: {
    safe_read:   'allow',     // override: always allow
    nuke_db:     'block',     // override: always block
  },
}
```

### Approval channels

| Channel | Status |
|---|---|
| `terminal` | Available — interactive prompt in your terminal |
| `slack` | Coming in v0.2 |
| `web` | Coming in v0.3 |
| `webhook` | Coming in v0.3 |

### Audit outputs

| Output | Status |
|---|---|
| `stdout` | Available |
| `file` | Available — JSON lines written to a local file |
| `otlp` | Coming in v0.2 |
| `webhook` | Coming in v0.2 |

---

## Packages

| Package | Description |
|---|---|
| `cordon-cli` | The CLI — `npx cordon-cli start` |
| `cordon-sdk` | TypeScript config SDK — `defineConfig()` and all types |
| `@cordon/core` | Core proxy engine — policy evaluator, audit logger, approval manager |

---

## Roadmap

- [x] MCP proxy with aggregator model (multiple servers, one gateway)
- [x] Policy engine — allow, block, approve, approve-writes, read-only, log-only
- [x] Terminal approval channel with TTY-safe prompt
- [x] Structured JSON audit logging to stdout and file
- [x] `cordon init` — auto-reads Claude Desktop config and patches it
- [ ] Slack approval integration
- [ ] Web dashboard — audit log history viewer
- [ ] OpenTelemetry export
- [ ] Rate limiting engine
- [ ] Audit log export (CSV/JSON) for compliance teams
- [ ] Team accounts and centralized governance
- [ ] HTTP/SSE transport support

---

## Examples

See [`examples/security-showcase`](./examples/security-showcase/) for a working demo of Cordon intercepting an agent that attempts to drop a production database table.

```bash
cd examples/security-showcase
npm install
npm run demo
```

---

## Use Cases

**Solo Developer** — Secure your local Claude/Cursor setup. See exactly what your agent is calling and block anything dangerous before it reaches production.

**Startup Team** — Deploy agents with confidence. Every tool call is logged, writes require approval, and your compliance team has a trail.

**Enterprise** — Centralized governance across all AI agent deployments. Policy-as-code, structured logs, and a clear path to SOC2-ready audit trails.

---

## Contributing

Cordon is open source and we welcome contributions.

```bash
git clone https://github.com/YOUR_USERNAME/cordon.git
cd cordon
npm install
npm run build
npm run dev
```

---

## License

MIT — see [LICENSE](./LICENSE) for details.

---

<p align="center">
  <strong>Stop trusting. Start governing.</strong>
  <br />
  <a href="https://github.com/YOUR_USERNAME/cordon">⭐ Star on GitHub</a>
</p>
