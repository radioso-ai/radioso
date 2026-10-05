# Contract: Ports and Pure Functions (1403 Email Channel)

TypeScript sketches, revised after the plan review. Names and members are binding; bodies are not. There is no `any`. Third-party payloads are `unknown` until an adapter narrows them. Each port lists its consumers, so the narrowest interface is obvious.

## 1. Mail ports (`backend/src/modules/mail/`, provider- and transport-only)

### 1a. `EmailDriver` (extended, `emailService.ts`)

```ts
export type EmailKind =
  | "email_verification" | "password_reset" | "account_invitation" | "conversation_transfer"
  | "channel_reply";                                    // new: redacted by every driver

export type RfcMessageId = string & { readonly __brand: "RfcMessageId" };       // emailHeaderValues.ts
export type HeaderSafeAddress = string & { readonly __brand: "HeaderSafeAddress" };

export interface OutboundThreadingHeaders {
  messageId: RfcMessageId;
  inReplyTo: RfcMessageId | null;
  references: readonly RfcMessageId[];
  autoSubmitted: "auto-generated" | null;               // RFC 3834; agent-authored only
}

export interface EmailMessage {                         // existing nullability preserved (emailService.ts:14-28, :54)
  to: string;
  from: { email: string; name?: string | null };
  replyTo?: string | null;
  subject: string;
  text: string;
  html?: string;
  kind?: EmailKind;
  metadata?: Record<string, string>;
  idempotencyKey?: string | null;
  threading?: OutboundThreadingHeaders | null;          // new
}

export interface EmailSendResult {
  dispatched: boolean;                                  // existing
  providerMessageId: string | null;                     // new, required: every driver and test fake returns it
  deliveredMessageId: RfcMessageId | null;              // new, required
}

export type SentEmailLastEvent =
  | "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed" | "suppressed" | "unknown";

export interface SentEmailStatus { providerMessageId: string; deliveredMessageId: RfcMessageId | null; lastEvent: SentEmailLastEvent }

export class EmailSendError extends Error {
  constructor(readonly certainty: "rejected" | "unknown", readonly code: string) { super(code); }
}

export interface EmailDriver {
  send(message: EmailMessage): Promise<EmailSendResult>;
  lookup(providerMessageId: string): Promise<SentEmailStatus | null>;   // new; log and noop return null
}
```

`providerMessageId` and `deliveredMessageId` are required, so these must change in the same task: `LogEmailDriver` and `NoopEmailDriver` (`emailService.ts`), `ResendEmailDriver`, and every `EmailDriver` / `EmailService` fake under `backend/tests/` (find them with `rg -l "EmailDriver|EmailSendResult" backend/tests`).

Consumers: transactional mail (unchanged call sites) and `EmailSendActionHandler`. For `kind === "channel_reply"`, the `log` and `noop` drivers log only `{ kind, idempotencyKeyHash, textBytes, hasHtml, hasThreading }`.

### 1b. `InboundEmailReceiver` (new, `inboundEmailReceiver.ts`)

```ts
export type AuthVerdict = "pass" | "fail" | "gray" | "processing_failed" | "unknown";

export interface InboundEnvelope {
  from: string | null;
  to: readonly string[];
  cc: readonly string[];
  receivedFor: readonly string[];
  subject: string | null;
  rfcMessageId: string | null;
}

export interface DeliveryStatusFacts {
  type: "sent" | "delivered" | "delivery_delayed" | "bounced" | "complained" | "failed" | "suppressed";
  bounce: { type: string; subType: string | null; statusCode: string | null } | null;
}

export type VerifiedInboundEvent =
  | { kind: "message_received"; providerEventId: string; providerObjectId: string; occurredAt: Date; envelope: InboundEnvelope }
  | { kind: "delivery_status"; providerEventId: string; providerObjectId: string; occurredAt: Date; status: DeliveryStatusFacts }
  | { kind: "domain_status"; providerEventId: string; providerObjectId: string; occurredAt: Date }
  | { kind: "unsupported"; providerEventId: string; occurredAt: Date; providerType: string };

export type InboundVerification =
  | { ok: true; event: VerifiedInboundEvent }
  | { ok: false; reason: "missing_signature" | "bad_signature" | "stale_timestamp" | "malformed_payload" };

export interface InboundEmailMessage {
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: readonly string[];
  from: { address: string; displayName: string | null } | null;
  to: readonly string[];
  cc: readonly string[];
  deliveredTo: readonly string[];                       // received_for ∪ Delivered-To ∪ X-Original-To
  subject: string | null;
  text: string | null;
  html: string | null;
  automation: { autoSubmitted: string | null; precedence: string | null; autoResponseSuppress: string | null; listId: string | null };
  report: { kind: "delivery_status"; originalMessageIds: readonly string[] } | null;
  attachments: readonly { name: string; contentType: string; sizeBytes: number }[];
  authentication: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
  spamVerdict: "spam" | "not_spam" | "unknown";
  raw: Buffer;
}

export interface InboundEmailReceiver {
  readonly provider: string;
  verify(request: { rawBody: Buffer; headers: Readonly<Record<string, string | undefined>>; now: Date }): InboundVerification;
  fetchMessage(providerObjectId: string): Promise<InboundEmailMessage>;   // throws InboundFetchError
}

export class InboundFetchError extends Error {
  constructor(readonly retryable: boolean, readonly code: string) { super(code); }
}
```

Consumers: `verify` → email webhook only. `fetchMessage` → inbound processor only.

### 1c. `EmailDomainProvisioner` (new, `emailDomainProvisioner.ts`)

```ts
export type ReadinessStatus = "pending" | "verified" | "failed";
export interface DnsRecordView {
  purpose: "dkim" | "spf" | "return_path" | "receiving_mx" | "dmarc";
  type: "TXT" | "MX" | "CNAME"; name: string; value: string; priority?: number;
  status: ReadinessStatus | "advisory";
}
export interface DomainReadiness { sending: ReadinessStatus; receiving: ReadinessStatus | "not_requested"; records: readonly DnsRecordView[] }
export type DomainRegistration =
  | { ok: true; providerDomainId: string; region: string | null; readiness: DomainReadiness }
  | { ok: false; refused: "claimed_elsewhere" | "invalid_domain" };

export interface EmailDomainProvisioner {
  readonly provider: string;
  registerSendingDomain(domain: string): Promise<DomainRegistration>;
  enableReceiving(providerDomainId: string): Promise<DomainReadiness>;
  requestVerification(providerDomainId: string): Promise<void>;
  readiness(input: { providerDomainId: string; domain: string }): Promise<DomainReadiness>;
  remove(providerDomainId: string): Promise<void>;
}
```

Consumer: `emailChannel/domains/sendingDomainService.ts` only.

## 2. Host port (`packages/connector-api/connectorPlugin.d.ts`)

`answer` is unchanged (`:25-45`). Two operations are added.

```ts
export type ConnectorTurnExecutionMode = "review";      // the only mode a plugin may request through `respond`

export interface ConnectorIngestInput {
  workspaceId: string;
  agentId: string | null;
  conversation:
    | { kind: "new"; conversationId: string; sourceChannel: string; channelContext: ConversationChannelContext }
    | { kind: "existing"; conversationId: string };
  message: { id: string; text: string; receivedAt: Date };            // caller-allocated (B15); idempotent
  humanOwnership: { reason: string } | null;
}

export interface ConnectorIngestResult {
  conversationId: string;
  messageId: string;
  conversationCreated: boolean;
  messageCreated: boolean;
  ownership: { state: "ai_owned" | "human_owned"; version: number };
}

export interface ConnectorRespondInput {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  respondToMessageId: string;
  executionMode: ConnectorTurnExecutionMode;
  historyWindow: { maxMessages: number };
}

export interface ConnectorTurnFacts {
  outcome: ConnectorChatOutcome;
  grounding: "grounded" | "ungrounded" | "not_applicable" | "unknown";
  coverage: "answered" | "partial" | "unanswered" | "unclear" | "unavailable" | "not_assessed";
  handoff: { requested: false } | { requested: true; reason: string };
  suppressedEffects: readonly { skillName: string }[];
  citationCount: number;
}

export interface ConnectorReplyDraft {
  readonly text: string;
  readonly presentation: Readonly<Record<string, unknown>>;            // host-owned; never inspected by plugins
}

export type ConnectorTurnResult =
  | { kind: "draft"; conversationId: string; ownershipVersion: number; facts: ConnectorTurnFacts; draft: ConnectorReplyDraft }
  | { kind: "no_draft"; conversationId: string; ownershipVersion: number; facts: ConnectorTurnFacts }
  | { kind: "human_owned"; conversationId: string; ownershipVersion: number };

export interface ConnectorChatPort {
  answer(/* unchanged */): Promise<{ conversationId: string; answer: string; outcome: ConnectorChatOutcome }>;
  ingest(input: ConnectorIngestInput): Promise<ConnectorIngestResult>;
  respond(input: ConnectorRespondInput): Promise<ConnectorTurnResult>;
}
```

`connectorChatPort.ts` maps `respond` to `ChatService.review` (§3), through the pure `connectorTurnFacts.ts` (research B3). `ingest` delegates to `ConversationIngestService`.

## 3. Backend turn execution (backend-internal)

```ts
// backend/src/shared/domain/turnExecutionMode.ts
export type TurnExecutionMode = "live" | "safe_test" | "review";
export interface TurnExecutionCapabilities {
  routines: "activate" | "skip";                         // covers activation AND the suspended-routine short-circuit
  completion: "persist_reply" | "return_draft";          // R1 ships "persist_reply" only; S3 adds "return_draft"
  ownershipHandoff: "apply" | "report" | "skip";         // R1 ships "apply" | "skip"; S3 adds "report"
  turnActions: "enqueue" | "drop";
  humanOwnedWaitingMessage: "generate" | "skip";
  turnBookkeeping: "record" | "skip";                    // product analytics, conversation summary refresh, caller audit event; safe_test and review skip
}
export const turnExecutionCapabilities: (mode: TurnExecutionMode | undefined) => TurnExecutionCapabilities;
export const resolveSkillEffectPolicy: (mode: TurnExecutionMode | undefined, requested?: SkillEffectPolicy) => SkillEffectPolicy;
// review → "suppressed" regardless of requested; live/safe_test rows unchanged

// backend/src/modules/chat/services/chatTurnLifecycle.ts (internal)
type CompletedAssistantTurn =
  | { kind: "persisted"; response: ChatResponse; assistantMessageId: string; postCommitReceipt: PostCommitInvalidationReceipt }
  | { kind: "draft"; draft: ReviewedTurnDraft; facts: ReviewTurnFactsSource;
      correlation: { requestMessageId: string; turnId: string }; postCommitReceipt: PostCommitInvalidationReceipt };

// backend/src/modules/chat/types/chatReview.ts (new; ChatResponse is NOT changed)
export interface ChatReviewInput {
  workspaceId: string; agentId: string; conversationId: string;
  existingUserMessageId: string; historyWindow: { maxMessages: number };
}
export interface ReviewedTurnDraft { text: string; presentation: Readonly<Record<string, unknown>> }
export interface ReviewTurnFactsSource {
  answerOutcome: AssistantTurnOutcome | null;
  answerCoverage: ChatAnswerCoverageAssessment | null;
  skillOutcome: string | null;
  ownershipHandoffSignal: { reason: string } | null;
  suppressedEffects: readonly { skillName: string }[];
  citationCount: number;
}
export type ChatReviewResult =
  | { kind: "draft"; conversationId: string; ownershipVersion: number; draft: ReviewedTurnDraft; facts: ReviewTurnFactsSource }
  | { kind: "no_draft"; conversationId: string; ownershipVersion: number; facts: ReviewTurnFactsSource }
  | { kind: "human_owned"; conversationId: string; ownershipVersion: number };

// ChatService
review(input: ChatReviewInput): Promise<ChatReviewResult>;   // new internal method; answer() unchanged
```

`live` and `safe_test` completions are always `kind: "persisted"`. A type-level test asserts that `answer()` can never observe `kind: "draft"`.

## 4. Held-reply ports (`backend/src/modules/handoff/public.ts`)

```ts
export type HeldReplyState = "pending" | "queued_auto" | "released" | "edited" | "discarded" | "superseded";
export type SupersedeReason = "newer_inbound" | "takeover" | "operator_reply" | "policy_changed";

export interface HoldReplyInput {
  workspaceId: string; conversationId: string; agentId: string | null;
  answersMessageId: string; ownershipVersion: number;
  policy: { ref: string; version: number } | null;
  reviewRef: string | null;                              // idempotency (B17)
  holdReason: string; facts: ConnectorTurnFacts; draft: ConnectorReplyDraft;
}

/** Producer port, consumed by the email review runner. */
export interface HeldReplyProducerPort {
  hold(input: HoldReplyInput): Promise<{ heldReplyId: string; state: "pending" | "superseded"; duplicate: boolean }>;
  queueAuto(input: Omit<HoldReplyInput, "holdReason">):
    Promise<{ ok: true; heldReplyId: string; duplicate: boolean } |
            { ok: false; refused: "ownership_changed" | "policy_changed" | "send_budget" | "superseded" }>;
  findByReviewRef(conversationId: string, reviewRef: string): Promise<{ heldReplyId: string; state: HeldReplyState } | null>;
}

/** Dispatch port, consumed by EmailSendActionHandler for auto replies (B9). */
export interface HeldReplyDispatchPort {
  materializeAuto(heldReplyId: string):
    Promise<{ ok: true; messageId: string } | { ok: false; reason: "not_queued" | "returned_to_pending" }>;
}

/** Transaction-bound; added to OwnershipChangeUnitOfWork, OwnershipReplyUnitOfWork, ConversationIngestUnitOfWork, MailboxPolicyChangeUnitOfWork scopes. */
export interface HeldReplySupersedeScope {
  supersedePendingForConversation(conversationId: string, reason: Exclude<SupersedeReason, "policy_changed">): Promise<number>;
  supersedePendingForPolicy(policyRef: string, reason: "policy_changed"): Promise<number>;
  clearDiscardedAttention(conversationId: string, reason: "operator_reply" | "takeover"): Promise<number>;
}

/** Transaction-bound, implemented by the producer (email keystone), bound by composition, keyed by policyRef prefix. */
export interface HeldReplyChannelScope {
  lockPolicy(policyRef: string): Promise<{ version: number } | null>;
  reserveAutoSend(conversationId: string): Promise<boolean>;
  authorizeAutoDispatch(heldReply: HeldReplyAuthorityView): Promise<{ authorized: true } | { authorized: false; code: string }>;
  enqueueAutoSend(heldReply: HeldReplyAuthorityView, outbox: CustomerReplyOutboxPort): Promise<void>;   // `email:send:held:<id>`, messageId null
  recordMaterialized(heldReply: HeldReplyAuthorityView, messageId: string): Promise<void>;
}
export interface HeldReplyAuthorityView { id: string; conversationId: string; policyRef: string | null; policyVersion: number | null; ownershipVersion: number }

/** Operator port, consumed by HTTP routes and Ray. */
export interface HeldReplyOperatorPort {
  list(actor: OwnershipActor, query: { attention: "open" | "all"; agentId?: string; cursor?: string; limit: number }): Promise<HeldReplyPage>;
  current(actor: OwnershipActor, conversationId: string): Promise<{ heldReply: HeldReplyView | null }>;    // object root (NB-3)
  release(actor: OwnershipActor, input: { conversationId: string; heldReplyId: string; editedText: string | null }):
    Promise<{ ok: true; heldReply: HeldReplyView; messageId: string } |
            { ok: false; refusal: "not_pending" | "ownership_changed" | "policy_changed" | "channel_not_ready"; current: HeldReplyView | null }>;
  discard(actor: OwnershipActor, input: { conversationId: string; heldReplyId: string }):
    Promise<{ ok: true; heldReply: HeldReplyView } | { ok: false; refusal: "not_pending"; current: HeldReplyView }>;
}
```

Changes to existing ownership code:
- `OwnershipChangeUnitOfWork` and `OwnershipReplyUnitOfWork` (`conversationOwnershipService.ts:50-72`) each gain one scope field, `heldReplies: HeldReplySupersedeScope`.
- `takeOver`, `transfer` (to self) and `reply` call it with `takeover` or `operator_reply`.
- `createPostgresOwnershipReplyUnitOfWork` (`conversationOwnershipReplies.ts:23-57`) and the change unit of work bind `HeldReplyRepository(trx)`.

These are the only changes there. `OperatorReplyService` is unchanged.

## 5. Customer-reply delivery additions (`backend/src/modules/customerReplyDelivery/`)

```ts
// Unchanged: CustomerChannelReplyDeliverer, CustomerReplyRoute, CustomerReplyDeliveryDispatcher. Registration: { slack, email }.
export type DeliveryFailureKind = "bounced" | "failed" | "uncertain" | "halted";
export interface DeliveryFailureRecorderPort {                       // producer: email keystone (tx-bound variant too)
  open(input: { workspaceId: string; conversationId: string; messageId: string | null; provider: string; kind: DeliveryFailureKind; detailCode: string | null }): Promise<void>;
  retarget(input: { conversationId: string; messageId: string; kind: DeliveryFailureKind; detailCode: string | null }): Promise<void>;
  clear(input: { conversationId: string; messageId: string | null; reason: "later_delivery" | "provider_evidence" | "operator_resolved" }): Promise<number>;
}
export interface DeliveryFailureReaderPort {                         // consumers: HTTP route, Ray needs_attention/triage
  listOpen(workspaceId: string, query: { agentId?: string; cursor?: string; limit: number }): Promise<DeliveryFailurePage>;
}
```

## 6. Pure decision functions

Inbound decisions live in `backend/src/modules/connectors/plugins/email/`, mirroring `plugins/slack/slackChannelMessageDisposition.ts`. Keystone pure functions live under `backend/src/modules/emailChannel/`.

### 6a. Classification (`plugins/email/emailInboundClassification.ts`)

```ts
export type InboundClassification = "person" | "automated_sender" | "bounce" | "self_sender" | "spam";
export const classifyInbound: (input: {
  message: Pick<InboundEmailMessage, "from" | "automation" | "report" | "spamVerdict">;
  ownAddresses: ReadonlySet<string>;
  isRadiosoOutboundId: (rfcMessageId: string) => boolean;
}) => { classification: InboundClassification; bouncedOutboundIds: readonly string[] };
```

### 6b. Mailbox routing (`emailChannel/mailboxes/mailboxRouting.ts`, research B20)

```ts
export type MailboxRoute =
  | { rule: "relay"; mailboxId: string; tokenGeneration: "current" | "previous" }
  | { rule: "direct"; mailboxId: string }
  | { rule: "direct_unknown"; workspaceId: string }
  | { rule: "relay_unknown" };
export const routeAddress: (address: string, lookups: {
  inboundDomain: string;
  relayToken(token: string): { mailboxId: string; generation: "current" | "previous" } | null;
  receivingDomain(domain: string): { workspaceId: string } | null;
  directMailbox(address: string): { mailboxId: string } | null;
}) => MailboxRoute | null;                                  // null: not a routable address (customer domain without direct receiving)
```

### 6c. Thread resolution (`plugins/email/emailThreadResolution.ts`, research B15)

```ts
export interface ThreadCandidates {
  forward: readonly { conversationId: string; matchedBy: "in_reply_to" | "references"; source: "index" | "reservation" }[];
  reverse: readonly { conversationId: string }[];
  byThreadToken: string | null;
  participantOf: (conversationId: string) => string;
}
export type ThreadResolution =
  | { kind: "existing"; conversationId: string; matchedBy: "in_reply_to" | "references" | "reverse_reference" | "thread_token"; conflict: boolean }
  | { kind: "participant_mismatch"; conversationId: string }
  | { kind: "new" };
export const resolveThread: (candidates: ThreadCandidates, sender: string) => ThreadResolution;
```

### 6d. Effective mode and engagement disposition (`emailChannel/mailboxes/effectiveMode.ts`, `plugins/email/emailEngagementDisposition.ts`)

```ts
export type EngagementMode = "operator_only" | "draft" | "auto";
export const effectiveEngagementMode: (accepted: { mode: EngagementMode; enabled: boolean }, current: { mode: EngagementMode; enabled: boolean }) =>
  { mode: EngagementMode; enabled: boolean };              // lower autonomy wins; enabled requires both

export interface EngagementDispositionInput {
  mailbox: { effectiveMode: EngagementMode; enabled: boolean; hasAgent: boolean; spamOptIn: boolean } | null;
  classification: InboundClassification;
  thread: { kind: "new" } | { kind: "existing"; ownership: "ai_owned" | "human_owned" } | { kind: "participant_mismatch" };
  generationBudgetExhausted: boolean;
}
export type DropReason = "no_mailbox" | "mailbox_disabled" | "automated_sender" | "self_sender" | "bounce" | "spam" | "participant_mismatch";
export type IngestOnlyReason = "operator_only_mailbox" | "human_owned" | "generation_budget" | "spam_opt_in" | "no_agent";
export type EngagementDisposition =
  | { kind: "drop"; reason: DropReason; noteOnThread: boolean }
  | { kind: "ingest_only"; reason: IngestOnlyReason; humanOwnershipReason: "operator_only_mailbox" | "generation_budget" | null }
  | { kind: "run_review_turn" };
export const resolveEngagementDisposition: (input: EngagementDispositionInput) => EngagementDisposition;
```

### 6e. Publication decision (`plugins/email/emailPublicationDecision.ts`, NB-4)

```ts
export type HoldReason = "sending_not_verified" | "draft_mode" | "send_budget" | "outcome_not_publishable" | "incomplete_answer" | "authority_changed";
export interface PublicationDecisionInput {
  effectiveMode: EngagementMode;
  turn: ConnectorTurnResult;
  sendBudget: { used: number; limit: number };
  bound: { ownershipVersion: number; policyVersion: number };
  current: { ownershipVersion: number; policyVersion: number };
  sendingReady: boolean;
  completeness: ReplyCompleteness | null;               // null: the completeness check has not run yet
}
export type PublicationDecision =
  | { kind: "publish" }
  | { kind: "check_completeness" }                       // every other gate would publish; decide again with a verdict
  | { kind: "hold"; reason: HoldReason }
  | { kind: "no_draft"; handoffReason: string | null };  // null only for the human-owned no-op
export const decidePublication: (input: PublicationDecisionInput) => PublicationDecision;
```

Order:
1. `human_owned` → `no_draft` with `handoffReason: null` (no-op).
2. `no_draft` → `no_draft` with `facts.handoff.reason` or `review_unavailable`.
3. Bound ≠ current (ownership or policy) → `hold` / `authority_changed`.
4. `!sendingReady` → `hold` / `sending_not_verified` (FR-004 wins over mode).
5. `effectiveMode !== "auto"` → `hold` / `draft_mode`.
6. Budget used ≥ limit → `hold` / `send_budget`.
7. Not (grounded ∧ coverage `answered` ∧ no hand-off ∧ no suppressed effects) → `hold` / `outcome_not_publishable`.
8. `completeness === null` → `check_completeness`.
9. `completeness !== "complete"` → `hold` / `incomplete_answer`.
10. Otherwise `publish`.

The decision reads no text. Only the completeness check, run once the first seven rules would publish, reads the draft and returns an enum.

### 6e-1. Review model checks (`plugins/email/emailReplyTriage.ts`, `emailReplyCompleteness.ts`)

Two structured model calls sit in the review path, each with its own prompt, verdict and fail-safe direction; the pure `decidePublication` above reads only their enums.

```ts
export interface EmailReviewSubject { workspaceId: string; agentId: string; conversationId: string; revision: number; attempt: number }

export type ReplyTriageVerdict = "yes" | "no" | "unsure" | "unavailable";
export interface EmailReplyTriagePort {
  assess(subject: EmailReviewSubject): Promise<ReplyTriageVerdict>;
}

export type ReplyCompleteness = "complete" | "partial" | "not_answered" | "unavailable";
export interface ReplyCompletenessResult { completeness: ReplyCompleteness; unansweredAsks: number | null }
export interface EmailReplyCompletenessPort {
  assess(subject: EmailReviewSubject & { draft: ConnectorReplyDraft }): Promise<ReplyCompletenessResult>;
}
```

`EmailReplyTriagePort.assess` runs before a review turn, on `backend/prompts/email-reply-needed.md`, which returns `reply_needed: "yes" | "no" | "unsure"`; the port adds `unavailable` for a model error, a 30s timeout, invalid output, or no incoming customer mail, and fails open — `unavailable` runs the review exactly as `yes` or `unsure` would.

`EmailReplyCompletenessPort.assess` runs only when `decidePublication` asks for `check_completeness`, on `backend/prompts/email-reply-completeness.md`, which returns `completeness: "complete" | "partial" | "not_answered"` plus `unanswered_asks`; the port adds `unavailable` for the same failure modes plus unreadable passages, and fails closed — anything but `complete` holds the reply.

### 6f. Outbound headers (`emailChannel/outbound/outboundHeaders.ts`)

```ts
export const buildOutboundHeaders: (input: {
  sendingDomain: string;
  latestInbound: { rfcMessageId: RfcMessageId | null; references: readonly RfcMessageId[] };
  authorKind: "agent" | "operator";
  newMessageUuid: string;
}) => OutboundThreadingHeaders;
export const replySubject: (latestSubject: string | null) => string;
export const replyToAddress: (mailbox: { address: string; plusAddressVerified: boolean }, threadToken: string) => HeaderSafeAddress;
```

### 6g. Send-intent transitions (`emailChannel/outbound/sendIntentTransitions.ts`, research B18)

```ts
export type SendIntentEvent =
  | { kind: "materialized" } | { kind: "revalidation_failed"; haltReason: "sending_not_verified" | "domain_removed" | "mailbox_removed" }
  | { kind: "provider_accepted"; providerMessageId: string; deliveredMessageId: string | null }
  | { kind: "provider_rejected"; code: string }
  | { kind: "outcome_unknown"; authorityValid: boolean; withinWindow: boolean }
  | { kind: "provider_status"; status: SentEmailLastEvent; source: "webhook" | "lookup" | "dsn" }
  | { kind: "reconcile_unsettled" }
  | { kind: "operator_resolution"; decision: "marked_sent" | "resend"; userId: string };
export const nextSendIntentState: (current: SendIntentSnapshot, event: SendIntentEvent) =>
  { next: SendIntentSnapshot; effects: readonly SendIntentEffect[] } | { ignored: "terminal" | "not_applicable" };
// Repository: transition(id, expectedVersion, event) → UPDATE … WHERE id=$1 AND version=$2; retried on conflict.
```

## 7. Durable payloads

### 7a. `email.send` outbox action

```ts
export const EMAIL_SEND_ACTION_TYPE = "email.send";
export interface EmailSendActionPayload {
  version: 1;
  trigger: "operator_reply" | "held_release" | "auto_reply" | "audited_resend";
  mailboxId: string;
  conversationId: string;
  messageId: string | null;                              // null only for auto_reply (materialized at dispatch)
  heldReplyId: string | null;                            // set for held_release and auto_reply
  authority: { policyVersion: number; ownershipVersion: number; mode: EngagementMode; domainId: string };
}
// Keys: `email:send:msg:<messageId>` (operator_reply, held_release), `email:send:held:<heldReplyId>` (auto_reply),
//       `email:send:msg:<messageId>:resend:<n>` (audited_resend). No text, addresses or subject in the payload.
```

### 7b. Drain wakeups (research B7)

```ts
export interface EmailChannelDrainRequest { maxJobs: number; stage: "inbound" | "review" | "reconcile" | "all"; scheduleAt?: Date }
export interface EmailChannelDrainDispatcherPort { requestDrain(request: EmailChannelDrainRequest): Promise<void> }   // noop locally
// R3: backend/src/shared/infra/cloudTasksDrainDispatcher.ts keeps the facet dispatcher's scheduleAt semantics.
```

## 8. Ray projection (NB-2)

```ts
// backend/src/modules/emailChannel/copilot/emailChannelCopilotView.ts. Explicit field selection at runtime.
export interface EmailMailboxCopilotView {
  id: string; address: string; agentId: string | null; engagementMode: EngagementMode; enabled: boolean;
  receivingState: "waiting_for_first_message" | "ok" | "silent"; lastReceivedAt: string | null;
  sendingState: "ok" | "not_verified" | "domain_removed"; threadSendBudget: number; hourlyGenerationBudget: number;
}   // never: relayAddress, relay tokens, setup-check recipients, thread tokens, raw content
export interface EmailEventLogCopilotSummary { mailboxId: string; window: string; byDisposition: Record<string, number>; failed: number; lastReceivedAt: string | null }
```

## 9. Composition seams (`backend/src/app/composition/`)

| File | Assembles |
|---|---|
| `emailChannel.ts` | env → adapters; `EmailPlugin`; `EmailSendActionHandler` registration; `email` deliverer; worker, sweep and drain dispatcher; `supportedModes`; registers the email `HeldReplyChannelScope` under prefix `email_mailbox:`. Returns `null` when unconfigured. |
| `conversationIngest.ts` | `ConversationIngestUnitOfWork`: conversation, message, ownership, activity and held-reply supersede scope in one transaction |
| `heldReplyUnitOfWork.ts` | release, discard, queue-auto and materialize-auto transactions: conversation lock → ownership lock → channel scope (policy lock, budget, authority) → held-reply conditional update → message → route enqueue or send-intent record; drain push after commit |
| `mailboxPolicyChange.ts` | mailbox row lock + policy history row + `supersedePendingForPolicy` |
| `conversationOwnershipReplies.ts` (modified) | binds `HeldReplyRepository(trx)` into the reply and change scopes |
| `emailChannel.ts` (review checks) | injects `reviewInference` (the workspace's answer-tier `ContextualStructuredInferenceFactory`), a transcript reader over the conversation's messages, and a grounding reader over the draft's recorded chunks into `ModelEmailReplyTriage` and `ModelEmailReplyCompleteness`; the review runner records a silenced triage's `no_reply_needed` note as a `channel_exception` activity. |
