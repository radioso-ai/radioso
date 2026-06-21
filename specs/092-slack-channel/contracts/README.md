# Contracts: Slack Channel

Design-time contracts for review. HTTP endpoints are added to the code-first OpenAPI registry (`backend/src/app/http/openapi/document.ts`); `backend/openapi.yaml`/`.json` are regenerated, never hand-edited. The inbound webhook is mounted via the connector host and is **not** part of the public OpenAPI surface.

## 1. Admin REST (OpenAPI surface) — zero-token

All under `/api/v1/agents/{agentId}` or `/api/v1/workspaces/{workspaceId}` (final placement during tasks). Permission: `workspace.agents.manage` (write), `workspace.agents.read` (read). **No endpoint accepts a bot token, client secret, or signing secret** (FR-001).

| Method/Path | Purpose | Notes |
|---|---|---|
| `POST  …/slack/install/start` | Begin "Add to Slack" OAuth | Returns the Slack authorization URL (PKCE/state via `integrationOauth`). |
| `GET   …/slack/install/status` | Connection status | `connected` / `needs_reauth` / `disabled` / `not_configured`; never returns secrets, only `connected: bool` + team name. |
| `GET   …/slack/binding` / `PUT …/slack/binding` | Read/set routing | `answeringAgentId`, `escalationChannelId` (nullable). |
| `GET   …/slack/manifest` | Self-host manifest (FR-021) | Returns app manifest pre-filled with `APP_BASE_URL` (scopes, event URL, redirect URI) + required env var names. |
| `DELETE …/slack/installation` | Disconnect | Revokes/marks disabled; deletes credential rows. |

OAuth completion reuses the generic `GET /oauth/callback/:provider` (provider = `slack`) + frontend `app/oauth/connections/callback`.

## 2. Inbound webhook (connector host, not OpenAPI)

`POST /api/connectors/slack/events` (single, multi-tenant by `team_id`).

- **`url_verification`**: respond with the `challenge` value (FR-006).
- **Signature**: verify `X-Slack-Signature` = `v0=` HMAC-SHA256 over `v0:{X-Slack-Request-Timestamp}:{rawBody}` with the signing secret; reject if timestamp outside the replay window (FR-007). Raw body required.
- **Dedupe**: idempotent insert on Slack `event_id` (`slack_inbound_events`); duplicate → ack, no turn (FR-008).
- **Loop guard**: ignore events where the author is the bot user (`botUserId`) or any bot (FR-009).
- **Ack**: 200 within 3s; turn runs async (FR-008).
- **Events handled**: `message.im` (Phase 1), `app_mention` (Phase 4). Routing: `team_id` → `slack_installations` → binding → answering agent.

## 3. Turn invocation (internal seam)

`ConnectorChatPort.answer({ workspaceId, conversationId?, query, stream:false, sourceChannel:"slack" }) → { conversationId, answer, outcome }`

- **Contract change**: result MUST carry a **typed outcome** distinguishing grounded answer vs no-context (e.g. `outcome: "answered" | "no_context"`, sourced from the existing grounded-answer flag). The Slack channel reads this typed field to drive gap escalation — never the `answer` text (FR-016, research D7).

## 4. Outbound action (existing outbox)

New action `type: "slack.post"` on `routine_action_requests`.

```jsonc
{
  "type": "slack.post",
  "payload": {
    "installationId": "uuid",
    "channelId": "C…",            // escalation channel or reply target
    "text": "…",                  // sanitized; never logged
    "threadTs": "…",              // optional (in-thread reply / mention)
    "conversationRef": "uuid",
    "kind": "gap_escalation" | "channel_reply" | "routine_post"
  },
  "idempotencyKey": "slack:{kind}:{turnOrStepId}"   // no duplicate spam (FR-018)
}
```

- One handler resolves the credential (installation → `integration_connections` → `integration_oauth_connections`) and posts via `SlackWebApiClient`; dispatcher provides retry/backoff (FR-018).
- **Two enqueue triggers, never conflated** (FR-017 gap policy by typed outcome; FR-019 routine `slack` skill). Shared handler + client (FR-020).
- Channel **reply** (FR-010/012) may post directly via the client in the turn worker for latency; escalation/routine go through the outbox for reliability. All share the client + credential.

## 5. Manifest contract (self-host)

`GET …/slack/manifest` returns a Slack app manifest with:
- `oauth_config.redirect_urls`: `{APP_BASE_URL}/api/v1/oauth/callback/slack`
- `settings.event_subscriptions.request_url`: `{APP_BASE_URL}/api/connectors/slack/events`
- bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write` (search scopes intentionally excluded — Non-Goal)
- accompanying list of env vars to set: `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.

## Observability (all paths)

Emit identity/count-only signals for install, inbound receipt, turn dispatch, outbound delivery; never message text, tokens, secrets, or retrieved content (FR-021).
