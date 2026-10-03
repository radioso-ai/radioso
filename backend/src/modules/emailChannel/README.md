# Email Channel Module

Owns the channel-keystone state for a customer mailbox reached through
email: sending and receiving domains, mailboxes and their relay tokens,
engagement mode and budgets, the inbound event log and its retention, raw
message storage and the sanitized view of it, thread-message-id bookkeeping,
and the read-only facts an email conversation shows in the inbox. Mailbox
policy changes (mode, enabled, agent) live here too, through
`MailboxPolicyChangeUnitOfWork` — the one seam that supersedes a pending
held reply in the same transaction as the change that invalidated it.

It does not own:

- **Transport.** `backend/src/modules/connectors/plugins/email/` holds the
  webhook mount and the pure functions that decide what an inbound message
  means — `emailInboundClassification.ts`, `emailThreadResolution.ts`,
  `emailEngagementDisposition.ts` — and calls down into this module's
  repositories and services. This module knows nothing about HTTP, the
  webhook signature, or the worker that drains inbound events.
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
  (`effectiveMode.ts`), receiving-state derivation
  (`receivingState.ts`), and the policy change-of-record
  (`mailboxPolicyChangeUnitOfWork.ts`).
- `domains/` — sending-domain registration and readiness
  (`sendingDomainService.ts`, `sendingState.ts`).
- `content/` — the quoted-history stripper (`quotedHistory.ts`), the
  customer-text extraction step (`customerText.ts`), and the sanitized raw
  message view (`rawMessageView.ts`).
- `eventLog/`, `facts/`, `copilot/` — the mailbox event log with its
  operator actions (retry a failed delivery, open its audited raw message),
  the conversation-level email facts, and the read-only Ray projection.
- `persistence/` — one repository per table, no business rules.
- `drains.ts` — the drain and sweep ports the worker and the task routes
  call; `infra/` holds the Cloud Tasks drain dispatcher built on the shared
  `scheduleAt` dispatcher.
- `maintenance/` — the sweep: lease recovery, the send reconciler's claim
  step, domain readiness refresh, and retention.
- `operator/` — the `email` customer reply deliverer registered in the
  shared reply dispatcher. It refuses `409 email_sending_not_verified`
  (naming the missing step) before anything is written, and otherwise
  queues `email.send` in the reply's transaction.
  `emailDeliveryFailureResolver.ts` is the email half of a teammate's
  `resolve` decision: `marked_sent` settles an `uncertain` send, `resend`
  queues a new `email.send` under `email:send:msg:<id>:resend:<n>`.
- `outbound/` — the send path. `emailSendAction.ts` owns the `email.send`
  payload (v1, ids and authority only) and the three key formats;
  `emailSendActionHandler.ts` materializes the intent by key, revalidates on
  the first attempt only, freezes the request and sends through
  `providerSendAttempt.ts` with no transaction held across the provider
  call; `sendReconciler.ts` re-POSTs unknown outcomes inside 23 hours and
  looks accepted sends up after 24; `providerDeliveryEvents.ts` applies
  provider delivery events and inbound DSN bounces. Every writer applies
  `sendIntentTransitions.ts` through `sendIntentWriter.ts`, whose unit of
  work (bound in `backend/src/app/composition/emailChannel.ts`) commits the
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
pnpm run email:dev -- inbound <file.eml> --relay <relay address>                      # local provider, running API
pnpm run email:dev -- delivery --intent <send intent id> --type bounced                # a provider delivery event for a local send
```

Spec: `specs/1403-email-channel/`. Operator-facing behavior:
[`docs/email-channel.md`](../../../../docs/email-channel.md).
