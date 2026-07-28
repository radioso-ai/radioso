---
title: "Slack Channel"
description: "Connect a Radioso workspace and its agents to Slack direct messages, mentions, human escalation posts, and operator callbacks."
last_updated: 2026-06-30
---

# Slack Channel

The Slack channel lets people talk to Radioso agents from Slack. One Slack
workspace connects to one Radioso workspace — the one that installed the Slack
app. That workspace's default agent answers direct messages and channels that
do not have a specific agent. Individual Slack channels can be assigned to specific agents.

The same Slack connection can also post an escalation to a human Slack channel
when the agent has no grounded answer.

Slack is only a channel. It is not a document source. Radioso does not read
Slack history, does not call Slack search, and does not add Slack messages to
the knowledge base.

## What It Does

- Direct messages to the Slack bot are routed to the default Radioso agent.
- `@mention` events in Slack channels are answered in the originating thread.
  A channel-specific binding wins when one exists. Otherwise, Radioso uses the
  default agent.
- While the agent works on a message, Radioso adds an `eyes` reaction to it. Once
  the reply is posted, the `eyes` reaction is replaced with a check mark, or with
  an `x` if the reply could not be delivered.
- Each DM user and each mentioned channel thread maps to one Radioso
  conversation.
- When the turn outcome is `no_context`, gap escalation is enabled, and an
  escalation channel is configured, Radioso posts a human follow-up message to
  that channel.
- Routines can also use allowlisted Slack skills to post deliberate handoff or
  lead messages.
- Approval gates, handoffs, and unanswered questions arrive as interactive
  messages. Operators approve, deny, take over, reply to the customer, or hand
  back from Slack.
- A sibling Radioso workspace in the same organization can share the same Slack
  installation. It does not create a second bot identity for the same Slack
  workspace.

Answers still come from the agent's curated Radioso knowledge. If the curated
knowledge does not cover the question, the agent must decline safely or
escalate. The Slack channel does not make uncurated Slack content available to
the answer.

## Operator Actions in Slack

When the agent needs a person, Radioso posts an interactive message to the
operator channel. Operators act on it from Slack, without opening the dashboard.

Three kinds of events arrive in the operator channel:

- An approval gate posts the decision with one button per option. The options
  come from the routine, not a fixed approve or deny pair.
- A handoff, and an unanswered question (a gap), each post a card with a
  **Take over** button.

From these messages an operator can:

- Approve or deny a decision. The routine resumes with the chosen option.
- Take over a conversation. The agent stops answering it.
- Talk to the customer. A short Slack form opens, and the reply goes to the
  customer where the conversation started: back in their Slack direct message,
  or in the website chat.
- Hand the conversation back to the agent.

Only Radioso workspace members can act. Radioso matches the Slack user to a
member by email, so the Slack user's email must match their Radioso account. A
Slack user who is not a member, or who lacks the takeover permission, gets a
private message and the action does not run.

Each action is resolved by the same Radioso services the dashboard uses, and is
recorded with the operator who performed it. A button that is already out of
date, because someone resolved it first, is rejected without changing the
result.

These actions need the app's interactivity and user lookup scopes. If the Slack
app was installed before these were added, reinstall or re-consent it.

## Slack in the Activity View

A Slack conversation shows its real Slack context in the Activity view. The
conversation list and the detail view show the Slack workspace, whether it is a
direct message or a channel, the thread, and the Slack user. A Slack
conversation is not shown as a plain authenticated chat.

## Cloud Setup

On Radioso Cloud, Radioso owns the Slack app. Workspace admins do not enter
Slack tokens or app secrets.

1. Open the agent Slack channel settings.
2. Select **Add to Slack**.
3. Approve the Slack OAuth install.
4. Return to Radioso and confirm the default agent.
5. Optionally add channel-specific agent bindings.
6. Optionally set an escalation channel, such as `#support`.

The setup uses these API surfaces:

- `POST /api/v1/workspaces/{workspaceId}/slack/install/start`
- `GET /api/v1/workspaces/{workspaceId}/slack/install/status`
- `GET /api/v1/workspaces/{workspaceId}/slack/binding`
- `GET /api/v1/workspaces/{workspaceId}/slack/bindings`
- `PUT /api/v1/workspaces/{workspaceId}/slack/binding`
- `DELETE /api/v1/workspaces/{workspaceId}/slack/binding?channelId={channelId}`

## Self-Host Setup

Self-hosted deployments use the same OAuth flow. The difference is that the
operator supplies their own Slack app secrets through environment variables.

1. Set `APP_BASE_URL` to the public HTTPS URL where users open the Radioso
   dashboard.
2. Open the agent Slack channel settings and expand **Self-host setup**.
3. Copy the generated Slack app manifest.
4. In Slack, create an app from that manifest.
5. Set these environment variables from the Slack app:
   - `SLACK_OAUTH_CLIENT_ID`
   - `SLACK_OAUTH_CLIENT_SECRET`
   - `SLACK_SIGNING_SECRET`
6. Restart the backend.
7. Use **Add to Slack** in the Radioso UI.

Slack is available only when all three Slack environment variables are set.
If one is missing, Radioso does not start Slack OAuth install and the UI shows
which variable the operator still needs to configure.

### Split-host deployments

`APP_BASE_URL` is the dashboard origin. Radioso uses it for browser redirects,
such as the page shown after a Slack install completes.

Slack reaches the backend directly for the OAuth callback and the Events API.
When the backend runs on a different host than the dashboard, set
`CONNECTOR_PUBLIC_BASE_URL` to the backend's public HTTPS origin. The manifest
and the OAuth callback then use this host. A typical setup is a dashboard at
`https://app.example.com` and an API at `https://api.example.com`.

When `CONNECTOR_PUBLIC_BASE_URL` is not set, Radioso falls back to
`APP_BASE_URL`, which is correct when one host serves both.

The manifest is available from:

`GET /api/v1/workspaces/{workspaceId}/slack/manifest`

It fills, using `CONNECTOR_PUBLIC_BASE_URL` when set and otherwise `APP_BASE_URL`:

- `oauth_config.redirect_urls` with
  `{backend host}/api/v1/oauth/callback/slack`
- `settings.event_subscriptions.request_url` with
  `{backend host}/api/connectors/slack/events`
- `settings.interactivity.request_url` with
  `{backend host}/api/connectors/slack/interactivity`
- bot scopes for mentions, chat posting, message reactions, direct messages, and
  Slack user lookup
  (`users:read`, `users:read.email`)

If an existing Slack app was installed before message reactions or interactive
operator actions were available, reinstall or re-consent the app so Slack grants
the new reaction and user lookup scopes and sends interactivity callbacks to
Radioso.

The backend must be reachable by Slack at a public HTTPS URL. If Slack cannot
reach the callback, event, or interactivity URL, OAuth install and inbound messages cannot
complete.

## Data Flow

1. Slack sends OAuth callbacks to Radioso after app install.
2. Radioso stores the bot token encrypted and keyed by Slack `team_id` for the
   Radioso organization.
3. Slack sends Events API payloads to `/api/connectors/slack/events`.
4. Radioso verifies the Slack signature, checks replay age, deduplicates by
   `event_id`, and ignores bot-authored events.
5. Radioso resolves the agent from the Slack channel binding. Direct messages
   and unlisted channels use the default agent.
6. The Slack connector invokes the normal chat path with `sourceChannel:
   "slack"`.
7. Radioso posts the completed answer back to Slack through the stored bot
   token.
8. If the typed turn outcome is `no_context`, the Slack connector can enqueue a
   `slack.post` escalation to the configured human channel.
9. Operators act on interactive messages in Slack. Slack sends the button click
   or form submission to `/api/connectors/slack/interactivity`. Radioso verifies
   the signature, identifies the operator by email, and resolves the action
   through the same approval and conversation-ownership services the dashboard
   uses. A human reply is delivered to the customer's original channel.

Logs and telemetry must use identifiers and counts only. They must not include
Slack tokens, signing secrets, message text, prompts, completions, retrieved
chunks, or document content.
