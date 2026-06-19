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

- `POST /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/install/start`
- `GET /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/install/status`
- `GET /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/binding`
- `PUT /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/binding`

## Self-Host Setup

Self-hosted deployments use the same OAuth flow. The difference is that the
operator supplies their own Slack app secrets through environment variables.

1. Set `APP_BASE_URL` to the public HTTPS URL of the Radioso backend.
2. Open the agent Slack channel settings and expand **Self-host setup**.
3. Copy the generated Slack app manifest.
4. In Slack, create an app from that manifest.
5. Set these environment variables from the Slack app:
   - `SLACK_OAUTH_CLIENT_ID`
   - `SLACK_OAUTH_CLIENT_SECRET`
   - `SLACK_SIGNING_SECRET`
6. Restart the backend.
7. Use **Add to Slack** in the Radioso UI.

The manifest is available from:

`GET /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/manifest`

It fills:

- `oauth_config.redirect_urls` with
  `{APP_BASE_URL}/api/v1/oauth/callback/slack`
- `settings.event_subscriptions.request_url` with
  `{APP_BASE_URL}/api/connectors/slack/events`
- bot scopes for mentions, chat posting, and direct messages

The backend must be reachable by Slack at a public HTTPS URL. If Slack cannot
reach the callback or event URL, OAuth install and inbound messages cannot
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
