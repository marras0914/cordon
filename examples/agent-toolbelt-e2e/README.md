# Agent Toolbelt x Cordon — end-to-end verification

Three Node scripts that prove Cordon proxies [Agent Toolbelt's MCP server](https://www.npmjs.com/package/agent-toolbelt-mcp) correctly and captures every tool call in its audit log. Companion to the dev.to walkthrough _"Putting my own MCP server behind my own MCP gateway."_

## What each stage proves

| # | Script | What it proves |
|---|---|---|
| 01 | `01-toolbelt-direct.mjs` | Agent Toolbelt's MCP server starts via stdio, lists 27+ tools, `stock_thesis` is present. No Cordon involved. |
| 02 | `02-cordon-stdio.mjs` | Cordon proxies the same tools through its stdio transport. `tools/list` through Cordon returns the Agent Toolbelt catalog. |
| 03 | `03-cordon-http-audit.mjs` | Cordon's HTTP transport accepts a client over `http://127.0.0.1:7777/mcp` with Bearer auth, forwards a real tool call to Agent Toolbelt, and writes `tool_call_received` + `tool_call_completed` audit entries. |

If stage **03** passes, Cordon's audit log is capturing real Agent Toolbelt traffic end to end on your machine.

There's also a fourth, optional script — `capture-dashboard-screenshot.mjs` — that runs the same chain but with `audit.output: 'hosted'` so the event lands in your dashboard at `app.getcordon.com` instead of stderr. Useful for verifying your hosted setup works, or for generating a real screenshot of your audit log.

## Quickstart

```bash
cd examples/agent-toolbelt-e2e
npm install
export AGENT_TOOLBELT_KEY=atb_your_key_here   # optional for stages 01/02/03 (list_tools needs no auth)
./run-all.ps1                                 # PowerShell on Windows
# or run stages individually:
node 01-toolbelt-direct.mjs
node 02-cordon-stdio.mjs
node 03-cordon-http-audit.mjs
```

`npm install` pulls `agent-toolbelt-mcp`, `@getcordon/cli`, and the MCP SDK. No clone-and-build needed.

A free Agent Toolbelt API key (1,000 calls/month, no card) is at:

```bash
curl -X POST 'https://agent-toolbelt-production.up.railway.app/api/clients/register' \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com"}'
```

The three test stages use `list_tools` — a no-auth metadata call — so verification works without a key. Set `AGENT_TOOLBELT_KEY` when you want to call a real billable tool through the chain.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `AGENT_TOOLBELT_KEY` | (unset) | Bearer key for Agent Toolbelt's upstream API. Required for billable tools, not for `list_tools`. |
| `AGENT_TOOLBELT_URL` | `https://agent-toolbelt-production.up.railway.app` | Upstream API base. Override only if you're running Agent Toolbelt's API locally. |
| `AGENT_TOOLBELT_MCP_PATH` | resolved from `node_modules/agent-toolbelt-mcp` | Override to point at a local Agent Toolbelt MCP server checkout. |
| `CORDON_CLI_PATH` | resolved from `node_modules/@getcordon/cli` | Override to point at a local Cordon CLI checkout. |
| `CORDON_GATEWAY_TOKEN` | random 16-byte hex per run | Bearer token Cordon's HTTP transport requires from the MCP client. |

## What "pass" actually means

These scripts verify the **protocol chain** — that calls flow correctly through every layer. The audit JSON they capture is exactly what Cordon writes to its event stream; the dashboard at `app.getcordon.com` renders the same records as table rows if `audit.output` is `'hosted'` (with a `crd_...` Cordon API key) instead of the local `'stdout'` mode these scripts use.

If a stage fails, the error message points at which layer broke. Bring the cordon stderr tail (the script prints it on failure) when filing a Cordon issue.
