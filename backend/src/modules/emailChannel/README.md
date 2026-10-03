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
  ports; it does not construct provider requests itself.
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
- `maintenance/` — the sweep: lease recovery, domain readiness refresh,
  and retention.
- `operator/` — the `email` customer reply deliverer registered in the
  shared reply dispatcher.

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
```

Spec: `specs/1403-email-channel/`. Operator-facing behavior:
[`docs/email-channel.md`](../../../../docs/email-channel.md).
