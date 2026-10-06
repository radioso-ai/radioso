# Contract: HTTP Additions (1403 Email Channel)

Every operation below is added to the code-first registry: new path modules under `backend/src/app/http/openapi/paths/`, schemas under `backend/src/app/http/openapi/schemas/`, and registration in `backend/src/app/http/openapi/openApiPaths.ts`. Schemas reuse the Zod schemas the routes validate with. `backend/openapi.{json,yaml}` are regenerated with `cd backend && pnpm run generate:openapi` and never hand-edited. The webhook (section 4) is mounted by the connector host and is not part of the public OpenAPI surface, matching the Slack precedent.

Errors use the existing `errorResponse(...)` envelope (`{ error: { code, message } }`). Codes listed are the `error.code` values. Responses never include relay tokens of other mailboxes, thread tokens, provider API keys, webhook secrets or raw headers.

## 1. Email channel settings (workspace settings permission)

Base: `/api/v1/workspaces/{workspaceId}/email-channel`. Reads require `workspace.settings.read`; writes require `workspace.settings.manage`. Tag: `Email Channel`.

| Method | Path | operationId | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `` | `getEmailChannel` | none | `EmailChannelOverview` | 401, 403, 404 workspace |
| POST | `/mailboxes` | `createEmailMailbox` | `CreateEmailMailboxRequest` | 201 `EmailMailbox` | 400 `invalid_address`, 409 `mailbox_exists`, 409 `domain_claimed_elsewhere`, 409 `domain_needs_reconciliation`, 409 `domain_removal_pending`, 409 `engagement_mode_unavailable`, 502 `provider_unavailable`, 503 `email_channel_not_configured` |
| GET | `/mailboxes/{mailboxId}` | `getEmailMailbox` | none | `EmailMailbox` | 404 |
| PATCH | `/mailboxes/{mailboxId}` | `updateEmailMailbox` | `UpdateEmailMailboxRequest` | `EmailMailbox` | 400, 404, 409 `stale_policy_version`, 409 `engagement_mode_unavailable` |
| DELETE | `/mailboxes/{mailboxId}` | `removeEmailMailbox` | none | 204 | 404 |
| POST | `/mailboxes/{mailboxId}/relay-token/rotate` | `rotateEmailMailboxRelayToken` | none | `EmailMailbox` (new relay address; previous one valid for the grace period) | 404 |
| POST | `/mailboxes/{mailboxId}/setup-check` | `startEmailMailboxSetupCheck` | `{ step: "base" \| "plus_address" }` | `EmailMailboxSetupCheck` | 404 |
| GET | `/mailboxes/{mailboxId}/events` | `listEmailMailboxEvents` | query `cursor?`, `limit≤100`, `disposition?`, `state?` | `EmailEventPage` | 404 |
| GET | `/events` | `listEmailChannelEvents` | query `mailboxId?`, `cursor?`, `limit≤100`, `disposition?`, `state?` | `EmailEventPage`: every delivery attributed to the workspace, including a removed mailbox's retained events and mail a verified receiving domain accepted for an address no mailbox has (`mailboxId: null`, reason `no_mailbox`); `mailboxId` narrows to one mailbox, removed or not | 400 `invalid_cursor` |
| POST | `/events/{deliveryId}/retry` | `retryEmailInboundEvent` | none | 202 `EmailEvent` | 404, 409 `event_not_failed` |
| GET | `/events/{deliveryId}/raw` | `getEmailInboundRawMessage` | none | `EmailRawMessageView` (any delivery in the workspace's event log, `mailboxId: null` included) | 403 (needs `workspace.conversation.takeover` as well), 404, 410 `raw_purged` |
| POST | `/domains` | `addEmailSendingDomain` | `{ domain: string }` | 201 `EmailDomain`; `registration.status: needs_reconciliation` when the provider already holds the name | 400 `invalid_domain`, 409 `domain_claimed_elsewhere`, 409 `domain_removal_pending` (a removal of the name is still being cleaned up), 502 `provider_unavailable` |
| POST | `/domains/{domainId}/verify` | `verifyEmailDomain` | none | `EmailDomain` (refreshed) | 404, 409 `domain_needs_reconciliation`, 502 `provider_unavailable` |
| POST | `/domains/{domainId}/reconcile` | `reconcileEmailDomain` | none | `EmailDomain` (`registration.status: registered`): the provider's registration found by name and adopted for this workspace, or a fresh one when the provider no longer holds the name; audited `email_channel.domain` / `reconciled`. A registered domain is returned unchanged | 404, 409 `domain_not_awaiting_reconciliation` (still `registering`), 409 `domain_removal_pending`, 502 `provider_unavailable` |
| POST | `/domains/{domainId}/receiving` | `enableEmailDirectReceiving` | `{ confirmation: string }`, which must equal the domain | `EmailDomain` | 400 `confirmation_mismatch`, 404, 409 `domain_needs_reconciliation` |
| DELETE | `/domains/{domainId}` | `removeEmailDomain` | none | 204 | 404, 409 `domain_has_mailboxes` (remove mailboxes first) |

Schema sketches:

```ts
EmailChannelOverview = {
  configured: boolean;                       // provider + inbound domain present in this deployment
  inboundDomain: string | null;
  supportedModes: ("operator_only" | "draft" | "auto")[];   // S1/S2: ["operator_only"]; S3+: + "draft"; S6+: + "auto"
  defaultMode: "operator_only" | "draft" | null;            // "draft" once supported (FR-005); null with configured: false and supportedModes: []
  domains: EmailDomain[];
  mailboxes: EmailMailbox[];
}
EmailDomain = {
  id: string; domain: string;
  registration: { status: "registering" | "needs_reconciliation" | "registered" };
  sending: { status: "pending" | "verified" | "failed"; checkedAt: string | null };
  receiving: { status: "not_requested" | "pending" | "verified" | "failed"; checkedAt: string | null };
  records: { purpose: "dkim" | "spf" | "return_path" | "receiving_mx" | "dmarc"; type: "TXT" | "MX" | "CNAME"; name: string; value: string; priority?: number; status: "pending" | "verified" | "failed" | "advisory" }[];
}
EmailMailbox = {
  id: string; address: string; displayName: string; agentId: string | null; domainId: string;
  relayAddress: string;                      // <relayToken>@<inboundDomain>; shown only to settings readers
  engagementMode: "operator_only" | "draft" | "auto";
  enabled: boolean; policyVersion: number;
  threadSendBudget: number; hourlyGenerationBudget: number; silenceThresholdHours: number;
  receiving: { state: "waiting_for_first_message" | "ok" | "silent"; lastReceivedAt: string | null };
  sending: { state: "ok" | "not_verified" | "domain_removed" };
  plusAddressVerified: boolean;
  setupCheck: EmailMailboxSetupCheck | null;
}
CreateEmailMailboxRequest = { address: string; displayName: string; agentId?: string | null;
  engagementMode?: "operator_only" | "draft" | "auto";   // default = overview.defaultMode; must be in supportedModes
  threadSendBudget?: number; hourlyGenerationBudget?: number; silenceThresholdHours?: number }
UpdateEmailMailboxRequest = Partial<Omit<CreateEmailMailboxRequest, "address">> & { enabled?: boolean; expectedPolicyVersion?: number }
EmailMailboxSetupCheck = { step: "base" | "plus_address"; startedAt: string; status: "waiting" | "passed"; passedAt: string | null;
  instructions: { sendTo: string } }      // the real address, or a plus-addressed variant for step plus_address
EmailEvent = { id: string; createdAt: string; state: "pending" | "fetched" | "ingested" | "done" | "failed";
  classification: string | null; disposition: "ingest_only" | "run_review_turn" | "drop" | null; reason: string | null;
  sender: { address: string | null; displayName: string | null }; subject: string | null;
  auth: { spf: string; dkim: string; dmarc: string }; spamVerdict: "spam" | "not_spam" | "unknown";
  conversationId: string | null; threadConflict: boolean; hasRaw: boolean; retryable: boolean;
  mailboxId: string | null }              // null: accepted for an address no mailbox has
EmailEventPage = { items: EmailEvent[]; nextCursor: string | null }
EmailRawMessageView = { headers: { name: string; value: string }[];      // display-safe subset; never relay or thread tokens
  text: string | null; sanitizedHtml: string | null; truncated: boolean;
  attachments: { name: string; contentType: string; sizeBytes: number }[] }
```

`relayAddress` is returned only to `workspace.settings.read` callers on their own workspace. Mode, enabled and agent changes bump `policyVersion` and supersede pending held replies in the same transaction (research B1).

## 2. Inbox: email facts, held replies, delivery failures (conversation permission)

All require a workspace session and `workspace.conversation.takeover`, like `takeover`/`reply` (`backend/src/app/http/routes/conversationOwnershipRoutes.ts:74`). Tags: `Conversation Ownership` for the held-reply and delivery-failure routes, `Email Channel` for the facts route.

| Method | Path | operationId | Request | Response | Errors |
|---|---|---|---|---|---|
| GET | `/api/v1/conversations/{conversationId}/email` | `getConversationEmailFacts` | none | `ConversationEmailFacts` | 404 (also when the conversation is not an email conversation) |
| GET | `/api/v1/held-replies` | `listHeldReplies` | query `attention=open\|all`, `agentId?`, `cursor?`, `limit≤100` | `HeldReplyPage` | 401, 403 |
| GET | `/api/v1/conversations/{conversationId}/held-reply` | `getCurrentHeldReply` | none | `{ heldReply: HeldReply \| null }` (object root, MCP-safe) | 404 |
| POST | `/api/v1/conversations/{conversationId}/held-replies/{heldReplyId}/release` | `releaseHeldReply` | `{ editedText?: string }` (1..20000 chars) | 201 `HeldReplyReleaseResult` | 404, 409 `held_reply_not_pending` (body carries current state), 409 `ownership_changed`, 409 `policy_changed`, 409 `channel_not_ready` (the channel cannot lock the bound policy, or the conversation has no delivery route), 409 `email_sending_not_verified` (details name the missing `step`) |
| POST | `/api/v1/conversations/{conversationId}/held-replies/{heldReplyId}/discard` | `discardHeldReply` | none | `HeldReply` | 404, 409 `held_reply_not_pending` |
| GET | `/api/v1/delivery-failures` | `listDeliveryFailures` | query `state=open\|all`, `agentId?`, `cursor?`, `limit≤100` | `DeliveryFailurePage` | 401, 403 |
| POST | `/api/v1/delivery-failures/{failureId}/acknowledge` | `acknowledgeDeliveryFailure` | none | `DeliveryFailure` | 404, 409 `already_cleared` |
| POST | `/api/v1/delivery-failures/{failureId}/resolve` | `resolveDeliveryFailure` | `{ decision: "marked_sent" \| "resend" }` (`marked_sent` only for `uncertain`; `resend` for `uncertain` or `halted` once sending is ready) | `DeliveryFailure` | 404, 409 `not_resolvable`, 409 `email_sending_not_verified` |

One endpoint covers both release paths: no `editedText` is the unchanged release, and `editedText` present is the edited release. The two outcomes stay distinct in state, attribution and audit (FR-028, FR-029).

```ts
ConversationEmailFacts = {
  mailbox: { id: string; address: string; displayName: string; engagementMode: string };
  participant: { address: string; displayName: string | null };
  latest: { subject: string | null; cc: string[]; inboundAt: string | null };
  sending: { state: "ok" | "not_verified" | "domain_removed" };
  sendBudget: { used: number; limit: number; renewedAt: string | null };
  messages: { messageId: string; direction: "inbound" | "outbound"; subject: string | null; cc: string[];
    attachments: { name: string; contentType: string; sizeBytes: number }[];
    delivery: { state: "queued" | "accepted" | "delivered" | "bounced" | "failed" | "uncertain" | "halted"; failureCode: string | null } | null;
    rawDeliveryId: string | null }[];
}
HeldReply = { id: string; conversationId: string; agentId: string | null;
  state: "pending" | "queued_auto" | "released" | "edited" | "discarded" | "superseded";
  holdReason: string;                                          // producer code, rendered through UI copy keys
  facts: { grounding: string; coverage: string; handoff: { requested: boolean; reason: string | null }; outcome: string };
  dependsOnSuppressedAction: boolean; suppressedEffects: { skillName: string }[];
  draftText: string; editedText: string | null;
  createdAt: string; decidedAt: string | null; releaserUserId: string | null; editorUserId: string | null;
  attentionOpen: boolean; trace: HeldReplyTrace | null }   // null when the review turn's audit record is not readable; queued_auto rows are listed only with attention=all
HeldReplyTrace = {                      // the review turn's reasoning (FR-027): identifiers and codes, never prompt, completion or customer text
  turnId: string;                       // the review turn, from its `chat.answer` audit record (keyed on requestMessageId = answersMessageId)
  outcome: string | null;               // the record's answer-outcome code: grounded_success, coverage_partial, no_context_refusal, ...
  groundingVerdict: "grounded" | "degraded" | "no_support" | null;   // the record's grounding verdict
  coverage: string;                     // what the turn reported, as on `facts`
  handoffReason: string | null;
  suppressedEffects: { skillName: string }[] }
HeldReplyReleaseResult = { heldReply: HeldReply; messageId: string; delivery: "queued" }
DeliveryFailure = { id: string; conversationId: string; messageId: string | null; provider: string;
  kind: "bounced" | "failed" | "uncertain" | "halted"; detailCode: string | null;
  openedAt: string; clearedAt: string | null; clearReason: string | null }
```

Operator replies keep using `POST /api/v1/conversations/{conversationId}/reply` unchanged. On an email conversation whose sending domain is not verified, the email deliverer's `route()` refuses before anything is written, and the endpoint returns `409 email_sending_not_verified` (FR-004). In S1, before the send path exists, it refuses with `409 email_sending_not_available`.

## 3. Channel context variant (existing schemas)

`ConversationChannelContext` in `backend/src/app/http/openapi/schemas/assistantHistorySchemas.ts:319-340` gains:

```ts
z.object({
  provider: z.literal("email"),
  mailbox: z.object({ id: z.string().uuid(), address: z.string().email() }),
  threadKey: z.string().uuid(),
  participant: z.object({ address: z.string().email() }),
}).openapi("EmailConversationChannelContext")
```

The same variant is added to the TypeScript union in `packages/conversation-contract/index.d.ts:95-105`. Every endpoint that already returns `channelContext` (history, conversation detail, inbox lists) picks it up with no path change.

## 4. Webhook (connector host, not OpenAPI)

`POST /api/connectors/email/webhook`, mounted by `EmailPlugin` through `ConnectorContext.http.mount` (`backend/src/modules/connectors/services/connectorRegistry.ts:785-793`). It is registered only when `EMAIL_CHANNEL_PROVIDER` and `EMAIL_CHANNEL_INBOUND_DOMAIN` are set (mirrors Slack gating, `backend/src/modules/connectors/plugins/index.ts:21-30`).

- **Auth**: provider signature over the raw body through `InboundEmailReceiver.verify` (research A3). No session.
- **Inline work**: verify, then one transaction that inserts the `email_inbound_events` row (`ON CONFLICT DO NOTHING` on both dedupe keys) and so persists the processing obligation, then commit, then a best-effort drain push. Nothing else.
- **Responses**: `200` persisted or duplicate. `401` signature invalid or outside the timestamp tolerance (counted, never logged with body). `400` body not JSON or missing provider ids. `503` database unavailable, so the provider retries. Target p99 under 1 s (SC-008).
- Unknown provider event types are persisted as `unsupported` and acknowledged.

## 5. Internal worker task routes (worker service, not OpenAPI)

These are added in `backend/src/app/worker/emailChannelWorkerTaskRoutes.ts` behind the existing `/internal/tasks` worker-token middleware (`backend/src/app/worker/createWorkerTaskApp.ts:24`):
- `POST /internal/tasks/email-channel/drain` with body `{ maxJobs: number; stage?: "inbound" | "review" | "reconcile" | "all" }`. Pushed by Cloud Tasks, immediately or scheduled at `review_due_at`, the next retry time or the next re-POST time (research B7).
- `POST /internal/tasks/email-channel/sweep` with body `{ maxJobs: number }`. Run by Cloud Scheduler: lease recovery, domain refresh due, send reconciliation due, event-log retention.

## 5a. Governance registrations (each lands in the slice that adds the route or tool)

| Registry | Entries | Slice |
|---|---|---|
| `backend/src/app/http/apiPrincipalRoutePolicy.ts` | permission tuples for every `/email-channel` settings route (`workspace.settings.read` / `manage`, like `email-connections` `:343-349`); `sessionOnly(…, "workspace.conversation.takeover")` for `/conversations/:id/email`, `/held-replies`, `/conversations/:id/held-reply`, `/conversations/:id/held-replies/:id/{release,discard}`, `/delivery-failures`, `/delivery-failures/:id/{acknowledge,resolve}` (like takeover and reply, `:304-314`) | S1, S2, S3 |
| `backend/src/app/http/openapi/operationPermissionRequirements.ts` | `getEmailChannel`, `getEmailMailbox`, `listEmailMailboxEvents`, `listEmailChannelEvents` → `workspace.settings.read`; `getConversationEmailFacts`, `listDeliveryFailures`, `listHeldReplies`, `getCurrentHeldReply` → `workspace.conversation.takeover` (one-to-one Ray parity) | S1, S2, S3 |
| `copilotCapabilityProvenance` (`backend/src/modules/operatorCopilot/capabilityProvenance.ts`) | `email_channel_configuration`, `email_channel_events`, `email_conversation_facts` (S1); `held_replies` (S3) | S1, S3 |
| `operatorMcpDispositions` (`backend/src/modules/operatorCopilot/operatorMcpDisposition.ts`) | same four tools, `eligibleRead`-style read dispositions with object-rooted schemas | S1, S3 |
| `CopilotTriageSourceId` + `copilotTriageSourcePermissions` (`triageDigest.ts:43`, `escalationSources.ts:48-55`) | `delivery_failures: "workspace.conversation.takeover"`; held replies read under the existing `approvals` source | S2 (delivery_failures), S3 (held replies) |

## 6. Generated artifacts regenerated in the same change

1. `backend/openapi.json`, `backend/openapi.yaml`: `cd backend && pnpm run generate:openapi`.
2. `typescript-sdk/openapi/radioso.{json,yaml}` and `typescript-sdk/src/generated/{client.ts,types.ts}`: `cd typescript-sdk && pnpm run sync` (CI fails on drift).
3. `packages/radioso-mcp-server/src/generated/openapiTypes.ts`: `cd packages/radioso-mcp-server && pnpm run sync:openapi`, checked by `check:openapi`.
4. `packages/conversation-contract/index.d.ts`: hand-edited type union (it is the source, not generated).
5. Copilot coverage map, `backend/tests/unit/operatorCopilot/catalogCoverage.ts`. Every new `operationId` above maps to a tool or a stated exclusion, or `copilot-catalog-coverage.test.ts:204` fails:

| operationId | Coverage | Slice |
|---|---|---|
| `getEmailChannel`, `getEmailMailbox` | tool `email_channel_configuration` (token-free projection, ports §8) | S1 |
| `listEmailMailboxEvents`, `listEmailChannelEvents` | tool `email_channel_events` | S1 |
| `getConversationEmailFacts` | tool `email_conversation_facts` | S1 |
| `getEmailInboundRawMessage` | exclusion, `permanent`: raw customer mail and headers are never model input | S1 |
| `rotateEmailMailboxRelayToken` | `neverListExclusion("secret_rotation")` (`catalogCoverage.ts:302-308`) | S1 |
| `createEmailMailbox`, `updateEmailMailbox`, `removeEmailMailbox`, `startEmailMailboxSetupCheck`, `retryEmailInboundEvent`, `addEmailSendingDomain`, `verifyEmailDomain`, `reconcileEmailDomain`, `enableEmailDirectReceiving`, `removeEmailDomain` | exclusion, `deferred`: excluded from Ray this release (FR-047); customer-visible routing would need a proposal card (`catalogCoverage.ts:165`) | S1 |
| `listDeliveryFailures` | tool `needs_attention` (kind `delivery_failed`) | S2 |
| `acknowledgeDeliveryFailure`, `resolveDeliveryFailure` | exclusion, `permanent`: audited delivery decisions stay with a person | S2 |
| `listHeldReplies`, `getCurrentHeldReply` | tool `held_replies` | S3 |
| `releaseHeldReply` | `neverListExclusion("unattended_live_customer_reply")` (`catalogCoverage.ts:314`) | S3 |
| `discardHeldReply` | exclusion, `permanent` | S3 |

The 9 deferred exclusions raise the ratchet `maxDeferredCatalogExclusions` (`backend/tests/unit/operatorCopilot/copilot-catalog-coverage.test.ts:68`) from 102 to 111, with the reason recorded. The coordinator kept them `deferred` (plan, Accepted deviations, item 4), and the ratchet bump lands in S1 (tasks T093).
