# Data Model: Notification Email Caps And Hygiene

## Notification Delivery Outcome

- `requestId`: unique action request identity and idempotency key for the decision.
- `workspaceId`: tenant boundary used for daily accounting.
- `conversationId`: required conversation boundary used for dispatch accounting.
- `usageDate`: UTC date for daily email accounting.
- `outcome`: `allowed`, `workspace_daily_email_cap`, or `conversation_dispatch_cap`.
- `requestedEmailCount`: number of resolved recipients in the attempted fan-out.
- `reservedEmailCount`: requested count when admitted, otherwise zero.
- `dailyEmailLimit`: policy-resolved limit used for the decision.
- `conversationDispatchLimit`: fixed limit used for the decision.
- `createdAt`: immutable decision time.

### Invariants

- One row exists per request ID.
- Every row except a `conversation_dispatch_cap` denial contributes to conversation usage; a daily-email denial can still deliver a webhook.
- Only `reservedEmailCount` contributes to workspace/day usage.
- A daily-cap outcome still allows an independently configured webhook.
- A conversation-cap outcome allows neither email nor webhook.
- Concurrent decisions serialize on the workspace/day and conversation scopes.

## Plan Notification Allowance

- `dailyNotificationEmails`: positive integer on every Enterprise plan.
- OSS default: 100 recipient emails per workspace per UTC day.

## Recipient Change Audit

- `resourceType`: `agent` or `agent_skill`.
- `resourceId`: stable agent or skill ID.
- `previousRecipientCount` / `recipientCount`: bounded integers.
- `previousRecipientHashes` / `recipientHashes`: sorted SHA-256 digests of trimmed lowercase addresses.

No raw address is stored in audit metadata.
