# Project Brief

## What Cordon Is

Cordon is a security gateway for AI agents. It sits between the LLM client (Claude Desktop, Cursor, custom agents) and MCP servers, intercepting every tool call and enforcing a policy before it reaches the backend.

## The Problem It Solves

MCP has no built-in security model. An agent connected to an MCP server has full access — there is no middle ground between "off" and "full admin." This means:

- No audit trail of what agents did
- No way to block dangerous operations (DROP TABLE, file deletion)
- No approval workflow for sensitive writes
- No visibility for compliance teams

Enterprises want agentic AI but won't accept this risk profile. Cordon is the trust layer that makes production deployment viable.

## Core Value Proposition

> **Firewall. Auditor. Remote control.** One config file between your LLM and your data.

## Business Model

Product-Led Growth → SaaS.

1. Developer discovers Cordon, runs `npx cordon-cli start` locally
2. Hooks it up to their MCP servers, gets hooked on audit logs and approval flows
3. Brings it to their team → moves to Cordon Cloud for centralized governance
4. Team pays $49/mo for hosted dashboard, log retention, compliance exports

## Target Users

| Segment | Pain | How Cordon Helps |
|---|---|---|
| Solo developer | "I don't know what my agent is doing" | Audit log + approval prompts |
| Startup team | "We can't give the agent prod DB access" | approve-writes policy |
| Enterprise | "Compliance team says no to AI" | Exportable audit trails, SOC2-ready logs |

## Success Metrics (Month 1)

- 50–100 GitHub stars
- 10 active local users
- cordon-cli, cordon-sdk, @cordon/core published on npm
