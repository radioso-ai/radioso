# Email Channel Module

Owns the channel-keystone state for a customer mailbox reached through
email: sending and receiving domains, mailboxes and their relay tokens,
engagement mode and budgets, the inbound event log and its retention, raw
message storage and the sanitized view of it, thread-message-id bookkeeping,
and the read-only facts an email conversation shows in the inbox. Mailbox
policy changes (mode, enabled, agent, thread send budget) and a mailbox's
removal live here too, through `MailboxPolicyChangeUnitOfWork` — the one
seam that supersedes a pending held reply in the same transaction as the
change that invalidated it, and hands that draft's conversation to a person
through its `handoffs` port. It locks the drafts' conversations before the
mailbox, in the conversation lock protocol's order
(`backend/src/app/composition/conversationLockOrder.ts`).

It does not own:

- **Transport.** `backend/src/modules/connectors/plugins/email/` holds the
  webhook mount and the pure functions that decide what an inbound message
  means — `emailInboundClassification.ts`, `emailThreadResolution.ts`,
  `emailEngagementDisposition.ts`, `emailPublicationDecision.ts` — the two
  review model checks built on the shared `emailReviewChecks.ts` (which reads
  the conversation as the customer's and the business's messages),
  `emailReplyTriage.ts` and `emailReplyCompleteness.ts` — and the worker's
  two stages: `emailInboundProcessor.ts` (stage 1, which schedules a
  thread's coalesced review) and `emailReviewRunner.ts` (stage 2, which runs
  the reply triage before the turn, the review through the host's
  `respond`, the completeness check before an automatic send, and holds
  its draft through handoff's producer port). Both call down into this
  module's repositories and services. This module knows nothing about
  HTTP, the webhook signature, or the worker that drains inbound events.
- **Provider calls.** `backend/src/modules/mail/` is the only place that
  talks to Resend or the `local` driver (`EmailDriver`,
  `InboundEmailReceiver`, `EmailDomainProvisioner`). This module calls those
  ports with a provider-neutral `EmailMessage`; it does not construct
  provider requests itself.
- **Conversation and turn orchestration.** Whether an agent runs, what mode
  the engine executes a turn in, and how a held reply is released or
  discarded belong to the chat engine and the handoff domain. This module
  supplies the facts (mode, budgets, domain readiness) those decisions read.
- **Reuse by `backend/src/modules/customerEmail/`.** That module sends
  through a workspace's own OAuth-connected mailbox as an agent skill — a
  different product surface with no code shared with this one.

## Entry points

- `public.ts` — `MailboxService`, `SendingDomainService`, `EventLogReader`,
  `InboundEventActions`, `ConversationEmailFactsReader`,
  `EmailChannelCopilotView`, and the `email_domains` / `email_mailboxes` /
  inbound / thread-link repositories. The HTTP routes that call them live in
  `backend/src/app/http/routes/emailChannelRoutes.ts`; Ray's read tools in
  `backend/src/modules/operatorCopilot/tools/emailChannel.ts`.
- `mailboxes/` — relay-token issuance and rotation (`relayTokens.ts`),
  routing (`mailboxRouting.ts`), engagement-mode ordering
  (`effectiveMode.ts`), the hourly generation window
  (`generationBudget.ts`, which `EmailMailboxRepository.reserveGeneration`
  charges once per thread review revision), receiving-state derivation
  (`receivingState.ts`), and the policy change-of-record
  (`mailboxPolicyChangeUnitOfWork.ts`), which supersedes the drafts bound
  to the version it replaces and hands their conversations to a person.
- `heldReplyChannelScope.ts` — email's side of a held-reply transaction.
  Drafts are bound to `email_mailbox:<mailboxId>`; `lockPolicy` locks the
  mailbox row `FOR SHARE` and returns its policy version for handoff to
  compare, and `enqueueRelease` queues a released message as a
  `held_release` `email.send` under `email:send:msg:<messageId>`, refusing
  `409 email_sending_not_verified` when the mailbox can no longer send.
  Automatic sends (research B9) are a capability composition grants only
  where the deployment runs `auto`: `reserveAutoSend` spends the thread's
  send budget, `enqueueAutoSend` queues an `auto_reply` `email.send` under
  `email:send:held:<heldReplyId>` with no message, `authorizeAutoDispatch`
  rechecks FR-032 and the thread's budget at materialization
  (`outbound/sendAuthority.ts`, which the send handler applies again to a
  recovered automatic send before its request freezes), and
  `recordMaterialized` writes the send intent with the message. Without the
  capability every automatic send is refused (`auto_unsupported`).
  `createEmailHeldReplyChannelRegistration({ autoSend, provider })` in
  `backend/src/app/composition/emailChannel/review.ts` registers it under the
  `email_mailbox:` prefix; the composition passes `autoSend: true` where the
  deployment runs `auto`, and `false` when no provider is configured.
- `domains/` — sending-domain registration and readiness
  (`sendingDomainService.ts`, `sendingState.ts`).
- `content/` — the quoted-history stripper (`quotedHistory.ts`), the
  customer-text extraction step (`customerText.ts`), and the sanitized raw
  message view (`rawMessageView.ts`).
- `eventLog/`, `facts/`, `copilot/` — the mailbox event log with its
  operator actions (retry a failed delivery, open its audited raw message),
  the conversation-level email facts, and the read-only Ray projection.
- `persistence/` — one repository per table, no business rules, plus
  `EmailBacklogRepository`, the cross-table overdue counts the sweep samples.
- `drains.ts` — the drain and sweep ports the worker and the task routes
  call; `infra/` holds the Cloud Tasks drain dispatcher built on the shared
  `scheduleAt` dispatcher.
- `maintenance/` — the sweep: lease recovery, the send reconciler's claim
  step, domain readiness refresh, and retention. It returns stale
  `queued_auto` held replies whose `email.send` action is no longer pending
  or in progress (the outbox gave up before materializing) to `pending`
  through the held-reply dispatch port's `returnAbandonedAuto`. Where the
  deployment does not run `auto`, it also returns every stale `queued_auto`
  held reply to `pending` (the rollback path). Where metrics are on, each run
  ends by sampling the work past its stage's deadline into the
  `email_backlog` gauge.
- `operator/` — the `email` customer reply deliverer registered in the
  shared reply dispatcher. It refuses `409 email_sending_not_verified`
  (naming the missing step) before anything is written, and otherwise
  queues `email.send` in the reply's transaction.
  `emailDeliveryFailureResolver.ts` is the email half of a teammate's
  `resolve` decision: `marked_sent` settles an `uncertain` send, `resend`
  queues a new `email.send` under `email:send:msg:<id>:resend:<n>`.
- `outbound/` — the send path. `emailSendAction.ts` owns the `email.send`
  payload (v1, ids and authority only) and the three key formats;
  `emailSendActionHandler.ts` materializes the intent by key (an
  `auto_reply` through the held-reply dispatch port's `materializeAuto`),
  revalidates on the first attempt only, freezes the request and sends through
  `providerSendAttempt.ts` with no transaction held across the provider
  call; `sendReconciler.ts` re-POSTs unknown outcomes inside 23 hours while
  the trigger's authority holds (`repostAuthorized`) and looks accepted sends
  up after 24; `providerDeliveryEvents.ts` applies
  provider delivery events and inbound DSN bounces. Every writer applies
  `sendIntentTransitions.ts` through `sendIntentWriter.ts`, whose unit of
  work (bound in `backend/src/app/composition/emailChannel/outbound.ts`) commits the
  fenced transition with the delivery failure it raises or clears. The
  `email.send` handler is registered by `createEmailChannelApplicationModule`.

## Focused checks

```bash
cd backend
pnpm exec vitest run tests/unit/email-channel
pnpm exec vitest run tests/contract/email-channel-settings.contract.test.ts
pnpm exec vitest run tests/unit/operatorCopilot/email-channel-tools.test.ts
pnpm exec vitest run tests/unit/mail
pnpm exec vitest run tests/integration/email-channel-persistence.integration.test.ts
pnpm exec vitest run tests/integration/email-channel-schema-migrations.integration.test.ts
pnpm exec vitest run tests/integration/email-thread-protocol.integration.test.ts       # B15 interleavings, two workers
pnpm exec vitest run tests/integration/email-inbound.integration.test.ts               # end to end: SC-002, SC-003, B16
pnpm exec vitest run tests/integration/email-channel-crash-recovery.integration.test.ts # SC-007 inbound
pnpm exec vitest run tests/integration/email-review-revision.integration.test.ts        # B17 stale review, crash after hold
pnpm exec vitest run tests/unit/eval-suite/email-outcome-table.test.ts                 # outcome table, operator_only and draft rows
pnpm run email:dev -- inbound <file.eml> --relay <relay address>                      # local provider, running API
pnpm run email:dev -- delivery --intent <send intent id> --type bounced                # a provider delivery event for a local send
```

Spec: `specs/1403-email-channel/`. Operator-facing behavior:
[`docs/email-channel.md`](../../../../docs/email-channel.md).
