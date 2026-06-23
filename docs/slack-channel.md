---
title: "Slack Channel"
description: "Connect a Radioso agent to Slack direct messages, mentions, human escalation posts, and operator callbacks."
last_updated: 2026-06-23
---

# Slack Channel

The Slack channel lets people talk to a Radioso agent from Slack. The same
Slack connection can also post an escalation to a human Slack channel when the
agent has no grounded answer.

Slack is only a channel. It is not a document source. Radioso does not read
Slack history, does not call Slack search, and does not add Slack messages to
the knowledge base.

## What It Does

- Direct messages to the Slack bot are routed to the bound Radioso agent.
- `@mention` events in Slack channels are answered in the originating thread.
- Each DM user and each mentioned channel thread maps to one Radioso
  conversation.
- When the turn outcome is `no_context` and an escalation channel is configured,
  Radioso posts a human follow-up message to that channel.
- Routines can also use allowlisted Slack skills to post deliberate handoff or
  lead messages.

Answers still come from the agent's curated Radioso knowledge. If the curated
knowledge does not cover the question, the agent must decline safely or
escalate. The Slack channel does not make uncurated Slack content available to
the answer.

## Cloud Setup

On Radioso Cloud, Radioso owns the Slack app. Workspace admins do not enter
Slack tokens or app secrets.

1. Open the agent Slack channel settings.
2. Select **Add to Slack**.
3. Approve the Slack OAuth install.
4. Return to Radioso and confirm the answering agent.
5. Optionally set an escalation channel, such as `#support`.

The setup uses these API surfaces:

- `POST /api/v1/workspaces/{workspaceId}/slack/install/start`
- `GET /api/v1/workspaces/{workspaceId}/slack/install/status`
- `GET /api/v1/workspaces/{workspaceId}/slack/binding`
- `PUT /api/v1/workspaces/{workspaceId}/slack/binding`

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
- bot scopes for mentions, chat posting, direct messages, and Slack user lookup
  (`users:read`, `users:read.email`)

If an existing Slack app was installed before interactive operator actions were
available, reinstall or re-consent the app so Slack grants the new user lookup
scopes and sends interactivity callbacks to Radioso.

The backend must be reachable by Slack at a public HTTPS URL. If Slack cannot
reach the callback, event, or interactivity URL, OAuth install and inbound messages cannot
complete.

## Data Flow

1. Slack sends OAuth callbacks to Radioso after app install.
2. Radioso stores the bot token encrypted and keyed by Slack `team_id`.
3. Slack sends Events API payloads to `/api/connectors/slack/events`.
4. Radioso verifies the Slack signature, checks replay age, deduplicates by
   `event_id`, and ignores bot-authored events.
5. The Slack connector invokes the normal chat path with `sourceChannel:
   "slack"`.
6. Radioso posts the completed answer back to Slack through the stored bot
   token.
7. If the typed turn outcome is `no_context`, the Slack connector can enqueue a
   `slack.post` escalation to the configured human channel.

Logs and telemetry must use identifiers and counts only. They must not include
Slack tokens, signing secrets, message text, prompts, completions, retrieved
chunks, or document content.
