# Slack approvals — setup

Route Cordon's human-in-the-loop approvals to Slack: when a tool call hits an
`approve` policy, Cordon posts an **Approve / Deny** card to a channel and the
agent waits for a human to click.

There are two paths depending on how you run Cordon.

---

## A. Hosted (app.getcordon.com) — plug-and-play

**Click "Add to Slack", pick a channel, done.** No Slack app to create, no tokens
to paste.

1. In the dashboard, open the **Connect Slack** section → **Add to Slack** →
   authorize in your workspace. You're redirected back showing **Connected — \<your team\>**.
2. Set the **channel** the approval cards should post to (e.g. `#cordon-approvals`).
   Invite the Cordon bot to it if it's private (`/invite @Cordon`).
3. In your `cordon.config.ts`, that's the whole approvals block:
   ```typescript
   approvals: { channel: 'slack' },
   ```
   `endpoint` and `apiKey` are auto-loaded from `~/.cordon/auth.json` after
   `cordon login` (same credentials the hosted audit uses). No bot token or
   channel in the local config — the **server** posts the card using your
   workspace's stored (encrypted) bot token.

That's it. Trigger an `approve` policy and the card appears in your channel;
approve it and the agent proceeds, with the approver recorded in the audit log.

> Under the hood: Cordon is a distributed Slack app. "Add to Slack" runs an OAuth
> install and stores a per-workspace bot token (encrypted at rest). The local
> proxy only registers the pending approval and polls — it never touches Slack.

---

## B. Self-hosted / dedicated instance — bring your own Slack app

When you run your **own** cordon-server (own DB + env), it's single-tenant by
nature, so you wire one Slack app directly into the server env.

### 1. Create a Slack app
- <https://api.slack.com/apps> → **Create New App** → **From scratch**.

### 2. Bot scopes
- **OAuth & Permissions** → **Bot Token Scopes** → add **`chat:write`**
  (and `channels:join` if you want the bot to auto-join public channels).

### 3. Install + grab the bot token
- **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-…`).

### 4. Signing secret
- **Basic Information** → **App Credentials** → copy the **Signing Secret**.

### 5. Interactivity
- **Interactivity & Shortcuts** → On → **Request URL:**
  `https://<your-cordon-server>/webhooks/slack`.

### 6. Invite the bot to your channel
- `/invite @<your app>` in the channel. (Skipping this → `not_in_channel`.)

### 7. Server environment
```
SLACK_SIGNING_SECRET=<from step 4>
SLACK_BOT_TOKEN=<xoxb- from step 3>
```
The webhook resolves the workspace bot token from a stored install if present,
otherwise falls back to this `SLACK_BOT_TOKEN` — so a single-tenant instance
works with just these two vars.

### 8. Config
```typescript
approvals: {
  channel: 'slack',
  endpoint: 'https://<your-cordon-server>',
  apiKey: 'crd_...',
},
```

---

## Troubleshooting (from cordon's stderr / server logs)
| Symptom | Fix |
|---|---|
| CLI: "Slack approval unavailable: Slack not connected" | Connect a workspace (path A) or set the server env (path B). |
| CLI: "Slack approval unavailable: No Slack channel configured" | Set a default channel in the dashboard (path A). |
| Card never appears (`not_in_channel`) | Invite the bot to the channel. |
| Card appears, Approve does nothing | Interactivity Request URL wrong, or (self-host) signing secret mismatch. |
| Server: "Slack not configured" (503) on /webhooks/slack | `SLACK_SIGNING_SECRET` missing. |

## Timeout behavior
If no one responds within `timeoutMs`, the call is **denied** and logged as
`tool_call_denied` with reason "Approval timed out." (Preserving richer context
for a dropped call so it can be resumed is a separate, requested feature — see
`cordon-deux/planning/durable-context-resume-feature.md`.)

## Zero-setup alternative
`approvals: { channel: 'terminal' }` prompts in the terminal running cordon — no
Slack at all. Works when cordon runs in a terminal (not Claude Desktop, which has
no TTY).
