# Quickstart: Slack Channel

## Cloud

1. Open the agent Slack channel settings.
2. Click **Add to Slack**.
3. Approve the Slack OAuth install.
4. Confirm the agent binding in Radioso.
5. Optionally set an escalation channel.
6. DM the bot in Slack, or invite it to a channel and `@mention` it.

Mention replies are posted in the originating thread. When the agent has no
grounded answer and an escalation channel is configured, Radioso posts the
follow-up to that human channel.

Relevant endpoints:

- `POST /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/install/start`
- `GET /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/install/status`
- `GET /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/binding`
- `PUT /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/binding`
- `POST /api/connectors/slack/events`

## Self-Host

1. Set `APP_BASE_URL` to the public HTTPS backend URL.
2. Open **Self-host setup** in the Slack channel card.
3. Copy the generated manifest from:

   `GET /api/v1/workspaces/{workspaceId}/agents/{agentId}/slack/manifest`

4. Create a Slack app from the manifest.
5. Set the three Slack app env vars:

   - `SLACK_OAUTH_CLIENT_ID`
   - `SLACK_OAUTH_CLIENT_SECRET`
   - `SLACK_SIGNING_SECRET`

6. Restart the backend.
7. Use **Add to Slack** and approve the workspace install.
8. DM the bot, `@mention` it in a channel, and test escalation with a question
   that has no curated answer.

The generated manifest points Slack to:

- `{APP_BASE_URL}/api/v1/oauth/callback/slack`
- `{APP_BASE_URL}/api/connectors/slack/events`

Slack must be able to reach both URLs over public HTTPS.
