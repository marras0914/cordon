# Slack approvals — setup guide

Route Cordon's human-in-the-loop approvals to Slack: when a tool call hits an
`approve` policy, Cordon posts an **Approve / Deny** card to a channel, and the
agent waits for a human to click.

> **Read this first — who this works for today.** Slack approvals are currently
> **single-tenant**. The Cordon *server* verifies every button click against one
> `SLACK_SIGNING_SECRET` and updates the message with one `SLACK_BOT_TOKEN`, both
> read from the server's environment. That means Slack approvals work when **you
> control the Cordon server** — i.e. you self-host cordon-server, or you're using
> a shared workspace whose app is already wired into the server you connect to.
> A trial user on someone else's hosted Cordon **cannot** point their own Slack
> workspace at it yet (their app's signing secret won't match the server's).
> Per-workspace Slack is roadmap work — see
> `cordon-deux/planning/multi-tenant-slack-gap.md`.
>
> If you just want HITL without any of this, use `approvals.channel: 'terminal'`
> (works when cordon runs in a terminal; not in Claude Desktop, which has no TTY).

## What the flow actually does (so the steps make sense)

1. Local Cordon posts the card to Slack with your **bot token** (`chat.postMessage`,
   needs `chat:write`), and registers a pending approval on the Cordon server
   (`POST /approvals`, keyed by your `crd_` API key).
2. Local Cordon polls the server (`GET /approvals/:callId`) for the result.
3. A human clicks Approve/Deny → Slack sends the interaction to the app's
   **Interactivity Request URL** → the Cordon server verifies the HMAC signature
   against `SLACK_SIGNING_SECRET`, records the decision + **who clicked**, and
   updates the message with `SLACK_BOT_TOKEN`.
4. The poll picks up the decision and the call proceeds or is denied.

So there are two credentials, both from the **same Slack app**: the **bot token**
(local config *and* server) and the **signing secret** (server only).

## Steps

### 1. Create a Slack app
- <https://api.slack.com/apps> → **Create New App** → **From scratch**.
- Name it (e.g. "Cordon Approvals"), pick your workspace.

### 2. Add the bot scope
- **OAuth & Permissions** → **Bot Token Scopes** → add **`chat:write`**.
  (That's the only scope the flow uses — post a message and update it.)

### 3. Install to the workspace, grab the bot token
- **Install to Workspace** → authorize.
- Copy the **Bot User OAuth Token** — starts with `xoxb-`.

### 4. Grab the signing secret
- **Basic Information** → **App Credentials** → copy the **Signing Secret**.

### 5. Enable Interactivity
- **Interactivity & Shortcuts** → toggle **On**.
- **Request URL:** `https://<your-cordon-server>/webhooks/slack`
  (hosted: `https://app.getcordon.com/webhooks/slack`).
- Save. Slack sends button clicks here; the server verifies them.

### 6. Invite the bot to your channel
- In Slack: `/invite @Cordon Approvals` in the channel you'll use.
- Skipping this is the #1 failure — you'll see `not_in_channel` in cordon's stderr.

### 7. Set the server environment
On the Cordon server (Railway vars, or your self-host env):
```
SLACK_SIGNING_SECRET=<from step 4>
SLACK_BOT_TOKEN=<xoxb- from step 3>
```
> This step is why it's single-tenant — only whoever controls the server sets
> these, and there's one pair for the whole server.

### 8. Configure `cordon.config.ts`
```typescript
approvals: {
  channel: 'slack',
  slackBotToken: process.env.CORDON_SLACK_BOT_TOKEN ?? 'xoxb-...', // step 3
  slackChannel: '#cordon-approvals',                                // must match step 6
  endpoint: 'https://app.getcordon.com',                            // your Cordon server
  apiKey: 'crd_...',                                                // your Cordon API key
  timeoutMs: 120_000,                                               // no-response → denied + logged
},
```

### 9. Test
Run an agent that triggers an `approve` policy. You should see the card in Slack,
click Approve, and the message flips to **"✅ Approved by \<you\>"** while the agent
proceeds. The decision + approver land in the audit log.

## Troubleshooting (from cordon's stderr)
| Message | Fix |
|---|---|
| `not_in_channel` | Invite the bot to the channel (step 6). |
| `channel_not_found` | Channel name wrong, or bot can't see it. |
| `missing_scope` | Add `chat:write` (step 2), then **Reinstall to Workspace**. |
| `invalid_auth` / `token_revoked` | Re-issue the bot token (step 3). |
| Card appears, Approve does nothing | Interactivity Request URL wrong (step 5), or the server's `SLACK_SIGNING_SECRET` doesn't match the app (step 7). |
| `Slack not configured` (503) from the server | Server env vars missing (step 7). |

## Timeout behavior
If no one responds within `timeoutMs`, the call is **denied** and logged as
`tool_call_denied` with reason "Approval timed out." (Preserving richer context
for a dropped call so it can be resumed is a separate, requested feature — see
`cordon-deux/planning/durable-context-resume-feature.md`.)
