# Data Model: Slack operator experience (095)

## New table: `slack_operator_identities`

Links a Slack user to a Radioso account within an installation's workspace. Established lazily by email match.

| column | type | notes |
|--------|------|-------|
| `id` | uuid pk | |
| `workspace_id` | uuid not null | FK workspaces |
| `installation_id` | uuid not null | FK `slack_installations` |
| `slack_user_id` | text not null | e.g. `U123` |
| `account_id` | uuid not null | FK accounts (resolved operator) |
| `slack_display_name` | text | for provenance/UI; refreshed opportunistically |
| `created_at` / `updated_at` | timestamptz | |

- **Unique** `(installation_id, slack_user_id)`.
- Index `(workspace_id, account_id)`.
- Rows are a **cache + provenance record**, not authorization: the resolver re-checks current workspace
  membership + `workspace.conversation.takeover` permission on every use (a removed member must not keep acting).

## Conversations: typed channel context

Add `channel_context JSONB NULL` to `conversations` (new migration). Written at conversation creation by the
connector; read by the history presenter and customer-reply routing. Shape = `ConversationChannelContext`
(shared contract, below). `source_channel` stays as the coarse string; `channel_context` is the typed detail.
No Slack-specific columns and no joins to `slack_*` tables from history.

## Shared contract: `ConversationChannelContext` (`@radioso/conversation-contract`)

Discriminated union on `provider`. v1 variants:

```ts
type ConversationChannelContext =
  | { provider: "slack"; team: { id: string; name?: string };
      channel: { id: string; type: "im" | "channel" }; threadTs?: string;
      user: { id: string; displayName?: string } }
  | { provider: "web"; origin?: string }            // website_embed / authenticated / anonymous detail (optional)
  ;
```

- Connectors supply it via the chat `sourceContext` (extend the existing `sourceContext` to carry an optional
  `channelContext`). Backward compatible: `null` for conversations created before this feature.
- Customer-reply routing switches on `provider`.

## Outbox payload variant: `slack.post`

Extend `slackPostPayloadSchema` to a discriminated union (preserve existing plain-text shape):

```ts
// existing (kept): { installationId, channelId, text, threadTs?, conversationRef?, kind }
// added:
{ installationId, channelId, threadTs?, conversationRef?,
  kind: "operator_notification" | "human_reply" | "gap_escalation" | "routine_post",
  blocks?: BlockKit[],            // interactive variant
  text: string,                   // fallback/notification text (required by Slack even with blocks)
  updateTs?: string,              // when set, chat.update an existing message instead of postMessage
}
```

- `kind = operator_notification` → interactive decision/ownership message to the **operator channel**.
- `kind = human_reply` → human-agent reply to the **customer** channel (slack-origin conversations).
- Idempotency key derivation extended per kind (decision handle / message id / event id) — covered by the
  message-queue review. Retry/at-least-once semantics unchanged.

## Block Kit action contract (button `action_id` + `value`)

`value` is JSON, ≤2000 chars (Slack limit). Decoded by `slackInteractivityHandler`.

| action_id | value | resolves to |
|-----------|-------|-------------|
| `decision_resolve` | `{ handle, optionId, contentHash }` | `ApprovalDecisionService.resolve` |
| `ownership_takeover` | `{ conversationId, version }` | ownership `takeover` |
| `ownership_talk` | `{ conversationId, version }` | `views.open` reply modal |
| `ownership_handback` | `{ conversationId, version }` | ownership `handback` |
| (link button) | dashboard URL | open conversation |

Reply modal: `callback_id = ownership_reply`, `private_metadata = { conversationId, version }`, single
plain-text input → `view_submission` → ownership `reply` (source=human_agent) → `CustomerReplyDelivery`.

## Identity resolver contract

`SlackOperatorIdentityResolver.resolve({ installation, slackUserId }) → { accountId, displayName } | { rejected }`

1. cache hit + member still authorized → return.
2. else `users.info(slackUserId)` → email → workspace-member lookup by email → authorized? upsert + return.
3. else `rejected` (caller posts ephemeral reply; nothing resolves).

Narrow ports consumed: `WorkspaceMemberLookupPort.findByEmail(workspaceId, email)`, the existing permission
check for `workspace.conversation.takeover`, and `SlackWebApiClient.usersInfo`.

## Audit

Reuse `hitl.ownership` + decision audit event types; add `slackOperator: { slackUserId, displayName }` to
metadata and keep `decided_by`/owner = the resolved account. New status values for identity-miss/stale are
counters/logs, not new audit types.
