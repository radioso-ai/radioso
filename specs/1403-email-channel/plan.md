# Implementation Plan: Email Channel (customer-owned domain, operator-gated agent)

**Branch**: `1403-email-channel` (working branch `email-channel-scope`) | **Date**: 2026-10-03 | **Spec**: `specs/1403-email-channel/spec.md`

**Input**: Feature specification from `/specs/1403-email-channel/spec.md`

**Companion artifacts**: `research.md` (Phase 0 decisions with evidence), `data-model.md`, `contracts/openapi-additions.md`, `contracts/ports.md`, `contracts/events.md`, `quickstart.md`.

## Summary

Email becomes a Radioso channel in which the operator, not the agent, is the default author.

**Inbound.** A customer forwards `support@customer.com` from their existing mail service to an opaque relay address on a Radioso-operated inbound domain. Radioso receives the mail through a provider webhook (Resend first, behind provider-neutral ports). It persists the verified event before acknowledging, then processes it in a durable worker job: fetch the content, normalize it, classify it structurally (RFC 3834, DSN, self-sender), resolve the thread (Message-Id, then plus token), make the pure engagement disposition, and call the host port.

**Engagement.** Each mailbox runs in one of three modes:
- `operator_only`: the conversation is human-owned from creation and no turn runs.
- `draft` (default): one coalesced turn runs in a new channel-neutral `review` execution mode, with skill effects suppressed, routines skipped, and output returned rather than persisted. A pure publication decision always holds the reply as a channel-neutral held reply that an operator releases, edits, or discards.
- `auto`: the same review turn, but the reply is sent only when the typed turn facts are grounded, complete and carry no hand-off, and the thread's send budget has room.

**Outbound.** Every outbound email is an `email.send` outbox action. Operator replies and operator releases commit it with their message. An automatic reply commits it with a `queued_auto` held reply, and the message is written only when the dispatcher re-authorizes and materializes the send, so held content never appears as a message row. One worker revalidates authority before the first provider call and sends through the extended `EmailDriver` with a stable idempotency key, typed threading headers and RFC 3834 `Auto-Submitted`, from the customer's own DKIM/SPF-verified domain. Unknown outcomes never turn back into releasable drafts; they settle by provider evidence or an audited decision.

**Attention.** Operator attention reuses `approval` for held replies and human ownership for operator-only and budget-exhausted conversations. It adds `delivery_failed` once as a shared kind. Email conversations never auto-close.

**Shape.** The work follows the Slack keystone-plus-plugin shape: `mail/` holds the ports, `emailChannel/` is the keystone, and `connectors/plugins/email/` handles inbound. It deliberately replaces Slack's in-process post-ack processing (`backend/src/modules/connectors/plugins/slack/slackWebhook.ts:225-274`) with a database-claimed job that has a lease and runs in both worker runtimes.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend), TypeScript 5.7 with React 19 and Next.js 16 App Router (frontend)

**Primary Dependencies**: Express, Zod, Kysely, Pino, existing OpenTelemetry tracing, the action outbox (`routine_action_requests`, `ActionDispatcher`), Cloud Tasks drain dispatchers, the `connector-api` plugin host, `customerReplyDelivery`, `handoff`. New backend dependencies: `postal-mime` (MIT-0, MIME parsing), `html-to-text` (MIT), `sanitize-html` (MIT). The Resend API is called by `fetch` inside `mail/adapters/` only, with no SDK (`backend/src/modules/mail/adapters/resendDriver.ts:24-36`). Webhook signatures are verified with `node:crypto` (research A3).

**Storage**: PostgreSQL 16, with pgvector unused here. Ten new tables in ten migrations, `209`–`218` (data-model.md): `email_domains`, `email_mailboxes`, `email_mailbox_policies`, `email_inbound_events`, `email_inbound_deliveries`, `email_thread_links`, `email_thread_messages`, `email_send_intents`, `held_replies`, `conversation_delivery_failures`. One online, three-phase widening of `conversation_activity.kind`, plus one replacement partial index (research B19). Raw MIME is stored as capped `bytea`, with no new storage system.

**Testing**: Vitest (unit, integration, contract), Supertest, Playwright. Committed MIME, protocol and webhook fixture corpora. Table-driven deterministic outcome-table suite. Crash-at-boundary integration suite (SC-007). CI never touches DNS, a real mailbox, Resend or a live model.

**Target Platform**: Linux containers. Radioso Cloud runs two region stacks (EU, US), each with its own relay domain and its own provider account. Self-host Docker Compose uses the `local` provider or the customer's own Resend account and inbound domain.

**Project Type**: Web application (Express backend plus document/worker runtime, Next.js frontend) in a pnpm monorepo with shared contract packages.

**Performance Goals**: SC-008: webhook acknowledgement p99 under 1 s (one verified insert, no fetch); receipt to inbox p99 under 30 s (drain push plus one fetch); receipt to held reply p99 under 90 s under the stated budgets (coalescing window 60 s by default; a Cloud Tasks drain is scheduled at `review_due_at`, research B7, plus one review turn).

**Constraints**:
- No transaction is held across a model call or a provider call.
- No English keyword lists: classification, quoted-history stripping and publication are structural or typed.
- FR-045 redaction across every driver, log, metric, span and audit event.
- Fail-closed publication.
- `live` turn behaviour is byte-for-byte unchanged.
- No `if (sourceChannel === "email")` in the chat engine, chat service or operator reply service.
- No direct MX by default.

**Scale/Scope**: Per-workspace mailboxes (expected 1–20), with default per-mailbox budgets of 30 generations per hour and 3 automatic sends per thread per renewal. One webhook URL per deployment, multi-tenant by relay token. Backlog targets: under 100 pending inbound events and under 50 due reviews per region in steady state (alerting thresholds in contracts/events.md).

## Constitution Check

*GATE: passed at plan time; re-check after Phase 1 design (done below; no change).*

| Gate | Result | Justification |
|---|---|---|
| I. Spec-first delivery | PASS | `spec.md` exists with the CEO and challenge review folded in. Implementation waits for its approval. Every slice below traces to FR/AS ids. |
| II. Backend TDD | PASS | Each slice starts with failing tests: pure-function tables (classification, disposition, publication, threading, headers, state machines), adapter contract tests over recorded fixtures, and the integration and crash-recovery suites. Listed per slice in Phase ordering. |
| III. Stack discipline | PASS | Node.js and React, PostgreSQL. No new LLM path: review turns use the agent's configured model through the existing turn. The GPT-5.2 default is untouched. |
| IV. Secrets and configuration hygiene | PASS | `EMAIL_CHANNEL_*` and `RESEND_CHANNEL_*` variables added to `.env.example` (quickstart §1). The webhook secret and API key go in Secret Manager through Terraform (Rollout). Tokens are never logged or returned except a mailbox's own relay address to settings readers. |
| V. UI consistency | PASS | The email channel card reuses `SettingsCard`, `Badge`, `Input`, `Switch`, `SegmentedControl` and `Collapsible`, as `frontend/components/dashboard/settings/slack-channel-card.tsx` does. Held-reply and header panels reuse inbox components and tokens. No new styles. |
| VI. Modularity and encapsulation | PASS | Owning modules, seams, files kept small and refactor stories are named below. Composition owns adapter selection, plugin, outbox and deliverer registration, workers and the drain dispatcher (`backend/src/app/composition/emailChannel.ts`). Domain rules stay in modules. |
| VII. Customer data protection and reliability | PASS | Durable ingress before acknowledgement. At-least-once with idempotency on every hop. Raw bodies capped, with stricter access and audited views. Sanitized rendering with remote resources disabled. Retention bounded. Fails closed on unknown turn facts. Workers can be disabled. |
| VIII. Code-first API contracts | PASS | Every endpoint goes in the registry (`contracts/openapi-additions.md`). OpenAPI, SDK snapshot and MCP generated types regenerate in the same change. The message-queue impact review is below. |
| IX. Documentation parity | PASS | FR-044 docs list in Project Structure. Queue docs and monitoring alerts updated. The product-docs corpus is resynced. |
| X. Prompt asset ownership | PASS | No new prompt template. If S0 shows the review turn needs channel-format guidance, it goes in `backend/prompts/` as a channel-neutral "asynchronous reply" fragment selected by execution mode, never by email. |
| XI. Frontend testing discipline | PASS | Four Playwright journeys (domain setup, mailbox binding, draft review, operator reply). Unit tests only for the needs-attention merge, catalog resolution and setup-check polling state. No markup or class assertions. |
| Workflow: composition evaluated | PASS | See Application Composition. |
| Workflow: message-queue review | PASS | See Message-Queue Impact. |

No gate fails, so no complexity tracking is required.

## Project Structure

### Documentation (this feature)

```text
specs/1403-email-channel/
├── spec.md
├── plan.md              # this file
├── research.md          # Phase 0: provider verification (A1–A12), architecture decisions (B1–B20)
├── data-model.md        # tables, JSON shapes, state machines, migration matrix, snapshots
├── quickstart.md        # local drivers, fixture webhook, test and eval commands, S0 spike
├── contracts/
│   ├── openapi-additions.md   # endpoints, governance registrations, channel context, regenerated artifacts, coverage map
│   ├── ports.md               # mail ports, host port, review completion, held-reply ports and scopes, pure functions, payloads
│   └── events.md              # audit, telemetry, metrics, spans, alerts, runbooks
└── tasks.md             # Phase 2 ($speckit-tasks)
```

### Source Code (repository root)

`N` = new, `M` = modified. Slices (S0–S6, R1–R3) are defined in Phase ordering.

```text
packages/
├── connector-api/connectorPlugin.d.ts                  M  S1/S3  ingest (S1); respond, ConnectorTurnFacts, ConnectorTurnResult (S3)
└── conversation-contract/index.d.ts                    M  S1     `email` ConversationChannelContext variant

backend/
├── package.json                                        M  Setup  postal-mime, html-to-text, sanitize-html; `email:dev`
├── scripts/emailChannelDev.ts                          N  S1     signed fixture webhook poster (dev only)
├── src/
│   ├── shared/domain/turnExecutionMode.ts              M  R1/S3  capabilities (R1); `review` (S3)
│   ├── shared/infra/cloudTasksDrainDispatcher.ts       N  R3     shared dispatcher with scheduleAt
│   ├── modules/
│   │   ├── mail/
│   │   │   ├── emailService.ts                         M  S2     threading, required result ids, lookup, channel_reply redaction
│   │   │   ├── emailHeaderValues.ts                    N  S2
│   │   │   ├── inboundEmailReceiver.ts                 N  S1     port
│   │   │   ├── emailDomainProvisioner.ts               N  S1     port
│   │   │   ├── inboundMimeNormalizer.ts                N  S1
│   │   │   ├── public.ts                               M  S1
│   │   │   └── adapters/{resendApi,resendInboundReceiver,resendDomainProvisioner,localInboundReceiver,localDomainProvisioner}.ts  N S1
│   │   │       adapters/resendDriver.ts                M  S2
│   │   ├── emailChannel/                               N         keystone
│   │   │   ├── README.md, public.ts                    N  S1
│   │   │   ├── persistence/{emailDomain,emailMailbox,emailInbound,emailThread}Repository.ts  N S1
│   │   │   ├── persistence/emailSendIntentRepository.ts N S2     fenced transition(id, version, event)
│   │   │   ├── domains/sendingDomainService.ts         N  S1
│   │   │   ├── mailboxes/{mailboxService,relayTokens,receivingState,mailboxRouting,effectiveMode}.ts  N S1
│   │   │   ├── content/{quotedHistory,customerText,rawMessageView}.ts  N S1
│   │   │   ├── eventLog/eventLogReader.ts              N  S1
│   │   │   ├── facts/conversationEmailFacts.ts         N  S1     delivery fields S2
│   │   │   ├── copilot/emailChannelCopilotView.ts      N  S1     token-free Ray projection
│   │   │   ├── outbound/{outboundHeaders,sendAuthority,sendIntentTransitions,emailSendActionHandler,providerDeliveryEvents,sendReconciler}.ts  N S2
│   │   │   ├── operator/emailCustomerReplyDeliverer.ts N  S1/S2  S1 refuses; S2 routes
│   │   │   ├── heldReplyChannelScope.ts                N  S3/S6  lockPolicy (S3); reserveAutoSend, enqueueAutoSend, authorizeAutoDispatch, recordMaterialized (S6)
│   │   │   ├── maintenance/emailChannelSweep.ts        N  S1     recovery, refresh, retention; reconcile claim (S2)
│   │   │   └── infra/cloudTasksEmailChannelDrainDispatcher.ts N S1
│   │   ├── connectors/
│   │   │   ├── plugins/email/{emailPlugin,emailWebhook,emailInboundClassification,emailThreadResolution,emailEngagementDisposition,emailInboundProcessor,emailChannelWorker}.ts  N S1
│   │   │   ├── plugins/email/{emailPublicationDecision,emailReviewRunner}.ts  N S3
│   │   │   ├── plugins/index.ts                        M  S1
│   │   │   └── services/connectorChatPort.ts           M  S1/S3; services/connectorTurnFacts.ts N S3
│   │   ├── chat/
│   │   │   ├── types/chatReview.ts                     N  S3     ChatReviewInput/Result, ReviewedTurnDraft (ChatResponse untouched)
│   │   │   ├── services/conversationIngestService.ts   N  S1
│   │   │   ├── services/reviewDraft.ts                 N  S3     builds the draft from the unpersisted presentation
│   │   │   ├── services/chatService.ts                 M  R1/S3  capability guards; review() method
│   │   │   ├── services/chatSessionPreparer.ts         M  S3     existing-message load
│   │   │   └── services/chatTurnLifecycle.ts           M  R1/S3  discriminated CompletedAssistantTurn
│   │   ├── handoff/
│   │   │   ├── heldReplies/{heldReplyState,heldReplyService}.ts  N S3  producer, dispatch, operator ports
│   │   │   ├── conversationOwnershipService.ts         M  S1/S3  requestHumanOwnership (S1); heldReplies scope + supersede calls (S3)
│   │   │   ├── ownershipState.ts                       M  S1
│   │   │   └── public.ts                               M
│   │   ├── customerReplyDelivery/{deliveryFailures.ts N, public.ts M}  S2
│   │   ├── conversationActivity/{contracts/index.ts,presentation.ts,readService.ts}  M S1  kinds, closing kinds, recently-closed query on v2 index
│   │   └── operatorCopilot/
│   │       ├── tools/emailChannel.ts                   N  S1/S3  email_channel_configuration, email_channel_events, email_conversation_facts (S1); held_replies (S3)
│   │       ├── tools/{needsAttention,escalationSources,index}.ts  M S1–S3
│   │       ├── triageDigest.ts                         M  S2     `delivery_failures` source id
│   │       ├── capabilityProvenance.ts                 M  S1/S3
│   │       └── operatorMcpDisposition.ts               M  S1/S3
│   ├── app/
│   │   ├── composition/{emailChannel,conversationIngest,heldReplyUnitOfWork,mailboxPolicyChange}.ts  N S1/S3
│   │   ├── composition/conversationOwnershipReplies.ts M  S3     bind HeldReplyRepository(trx)
│   │   ├── composition/builtIn/agentSkillTurnSkillProvider.ts  M R2  suppression collector (turn + staged)
│   │   ├── composition/defaultComposition.ts           M  S1
│   │   ├── http/routes/{emailChannelRoutes,deliveryFailureRoutes,heldReplyRoutes}.ts  N S1/S2/S3
│   │   ├── http/apiPrincipalRoutePolicy.ts             M  S1/S2/S3
│   │   ├── http/openapi/operationPermissionRequirements.ts  M S1/S2/S3
│   │   ├── http/openapi/paths/{emailChannelPaths,deliveryFailurePaths,heldReplyPaths}.ts  N
│   │   ├── http/openapi/schemas/{emailChannelSchemas.ts N, assistantHistorySchemas.ts M}  S1
│   │   ├── server/builders/{eval.ts,chat.ts}           M  S1/S2  deliverer and handler registration
│   │   └── worker/{emailChannelWorkerTaskRoutes.ts N, createWorkerTaskApp.ts M}  S1
│   ├── runtime/startWorkerRuntime.ts                   M  S1
│   ├── db/migrations/209…218                           N         see data-model.md matrix
│   ├── db/repositories/{heldReplyRepository,conversationDeliveryFailureRepository}.ts  N S3/S2
│   ├── db/schema.sql                                   M         db:schema
│   └── shared/infra/kysely/schema.ts                   M         db:types
├── openapi.json, openapi.yaml                          M
└── tests/  (unit/email-channel, unit/mail, unit/handoff, unit/chat, contract, integration, fixtures/email-channel; see tasks.md)

typescript-sdk/openapi/, typescript-sdk/src/generated/  M         `pnpm run sync`
packages/radioso-mcp-server/src/generated/openapiTypes.ts M       `pnpm run sync:openapi`

frontend/
├── lib/{agent-channel-catalog.ts M, api-email-channel.ts N, email-setup-check-state.ts N}  S1
├── lib/{api-reply-review.ts N, needs-attention-reply-review.ts N, needs-attention.ts M, needs-attention-query-state.ts M}  S2/S3
├── components/dashboard/settings/{email-channel-card,email-domain-records,email-mailbox-events}.tsx  N S1
├── components/dashboard/settings/workspace-assistant-channels-tab.tsx  M S1 (mount only)
├── components/dashboard/inbox/email-conversation-header.tsx  N S1
├── components/dashboard/inbox/held-reply-panel.tsx     N  S3
├── components/dashboard/{inbox/inbox-response-view.tsx, operator-composer.tsx, spine-stage-detail.tsx}  M
└── tests/e2e/{email-channel-setup,email-operator-reply,email-draft-review}.spec.ts  N S1/S2/S3

docs/{email-channel.md N, human-takeover.md M, monitoring-alerts.md M, architecture/code-map.md M, architecture/assistant-turn-spine.md M, customer-email-skills.md M}
docs-portal/content/operators/{email-channel.mdx N, _meta.js M, copilot.mdx M}
packages/product-docs (corpus) M; readme.md M; .env.example M; .gitignore M
infra/terraform/{queue.tf,scheduler.tf,secrets.tf,compute.tf,variables.tf} M
```

**Structure Decision**: web application with shared contract packages.
- **Transport and inbound worker**: `backend/src/modules/connectors/plugins/email/`.
- **Channel keystone**: `backend/src/modules/emailChannel/`.
- **Provider ports**: `backend/src/modules/mail/`.
- **Channel-neutral concepts** extend their existing owners: held replies in `handoff/`, delivery-failure attention in `customerReplyDelivery/`, the `review` mode in `shared/domain/turnExecutionMode.ts` plus `chat/`, and the host port in `packages/connector-api`.
- **No new workspace package.**

## Module Ownership & Seams

- **Transport Layer**: `plugins/email/emailWebhook.ts` (verify, one idempotent insert, 200); `emailChannelRoutes.ts`, `heldReplyRoutes.ts` and `deliveryFailureRoutes.ts` (validation and permission only); `emailChannelWorkerTaskRoutes.ts` (drain and sweep triggers).
- **Orchestration Layer**: `emailInboundProcessor.ts` (stage 1, including the B15 protocol steps); `emailReviewRunner.ts` (stage 2, revision protocol B17); `emailSendActionHandler.ts`; `heldReplyService.ts`; `conversationIngestService.ts`. Each is readable top to bottom, with the rules delegated.
- **Domain Layer**:
  - classification, thread resolution, engagement disposition and publication decision (pure, in `plugins/email/`);
  - mailbox routing, effective mode, relay tokens and receiving state (pure, in `emailChannel/mailboxes/`);
  - outbound headers, send authority and send-intent transitions (pure);
  - quoted-history stripping;
  - held-reply state;
  - `turnExecutionCapabilities`.
- **Persistence/Integration Layer**: five keystone repositories, `heldReplyRepository.ts` and `conversationDeliveryFailureRepository.ts`. Provider HTTP only in `mail/adapters/` (one helper, `resendApi.ts`). The action outbox is reused unchanged.
- **Application Composition**: required.
  - `emailChannel.ts` selects adapters, builds the plugin, registers `email.send` (`server/builders/chat.ts:522-540`) and the `email` deliverer (`server/builders/eval.ts:113-124`), builds the worker, sweep and scheduled drain dispatcher, exposes `supportedModes`, and registers the email `HeldReplyChannelScope` under its `policyRef` prefix.
  - `conversationIngest.ts`, `heldReplyUnitOfWork.ts` and `mailboxPolicyChange.ts` bind repositories to one transaction and fix lock order. They hold no product rule.
  - `conversationOwnershipReplies.ts` binds `HeldReplyRepository(trx)` into the existing reply and change scopes.
- **Transaction-bound capabilities** (research B1, review #3): `HeldReplySupersedeScope` joins the existing ownership change and reply scopes, the ingest scope and the policy-change scope. `HeldReplyChannelScope` (policy lock, auto budget, auto enqueue, auto authority, materialized record) is implemented by the email keystone. Decisions stay in their owners: supersession in handoff, policy and budget in email.
- **Files Kept Small**:

| File | Lines | Allowed delta |
|---|---|---|
| `chat/services/chatService.ts` | 1841 | capability guards at `:896-911` and `:913-942` (activation and suspended routine); new `review()` delegating to the lifecycle |
| `chat/services/chatSessionPreparer.ts` | 1357 | existing-message branch delegating to a helper |
| `chat/services/chatTurnLifecycle.ts` | 1169 | discriminated completion; the `draft` branch delegates to `reviewDraft.ts` |
| `chat/types/chatResponses.ts` | 81 | **none** (review #2) |
| `handoff/conversationOwnershipService.ts` | 418 | `requestHumanOwnership`, one scope field per unit of work, three supersede calls |
| `handoff/operatorReplyService.ts`, `customerReplyDelivery/customerReplyDelivery.ts`, `plugins/slack/*` | | none |
| `mail/emailService.ts` | 128 | types, redaction, `lookup`; no inbound or DNS logic |
| `frontend/.../workspace-assistant-channels-tab.tsx` | 1354 | import and mount |
| `frontend/lib/needs-attention.ts` | 677 | union member, severity, merge call |
| `frontend/.../inbox-response-view.tsx` | 433 | conditional mounts |

- **Planned Extractions**: the mail ports; host `ingest`/`respond`; `ChatService.review` with `ChatReviewResult`; `TurnExecutionCapabilities`; the held-reply producer, dispatch, operator, supersede and channel-scope ports; the delivery-failure recorder and reader; `EmailChannelDrainDispatcherPort` (scheduled); `resendApi.ts`; `inboundMimeNormalizer.ts`; `EmailChannelCopilotView`.
- **Required Refactor Stories** (behaviour-preserving, one PR each):
  - **R1 (before S3)**: replace `safeTestTurn` in `chatTurnLifecycle.ts:669-787` and the mode comparisons in `chatService.ts` with `turnExecutionCapabilities(mode)` for `live` and `safe_test`. Introduce the discriminated `CompletedAssistantTurn` with only the `persisted` arm. **Acceptance** (NB-7):
    - a table test pins every `live` and `safe_test` capability;
    - routine activation **and** suspended-routine resume (`chatService.ts:933`) behave as before in both modes;
    - existing lifecycle, preparer, workbench-replay and skill-effect tests pass unmodified.
  - **R2 (before S3)**: add the per-turn suppressed-effects collector to `agentSkillTurnSkillProvider.ts`. **Acceptance**:
    - it records direct turn-skill suppression (`:309-311`) **and** staged-tool suppression (`:386-392`);
    - it is empty for `live`;
    - persisted reasons and the existing metric are unchanged.

    The mode-labelled counter is added in S3, not in R2.
  - **R3 (before the S1 drain wiring)**: extract `shared/infra/cloudTasksDrainDispatcher.ts`, with `scheduleAt` preserved from `cloudTasksFacetExtractionDrainDispatcher.ts:37-45`, out of the action and facet dispatchers. Their tests pass unchanged.

### Design Discipline: three questions per new module

| Module | Knows | Must not know | Ports exposed, to whom | Depends on |
|---|---|---|---|---|
| `mail/` | provider HTTP, signatures, MIME, DNS records, header syntax | workspaces, mailboxes, conversations | `EmailDriver` → transactional mail, `email.send` handler; receiver `verify` → webhook, `fetchMessage` → processor; provisioner → domain service | nothing in modules |
| `emailChannel/` | domains, mailboxes, policy history, routing, threads, deliveries, send intents, budgets, event log, content, outbound | chat internals, prompts, Slack/WhatsApp, how review runs | repositories and services → plugin, routes, Ray; deliverer and handler (by registration); `HeldReplyChannelScope` (by registration) | `mail/` ports, `customerReplyDelivery` recorder, `handoff` public ports |
| `plugins/email/` | webhook, job stages, classification, thread protocol, disposition, publication, review runner | provider wire formats, SQL, chat internals | `ConnectorPlugin`; worker `drain`/`sweep` | `connector-api`, `mail/`, keystone, handoff producer and dispatch ports |
| `handoff/heldReplies/` | held-reply lifecycle, binding, release and materialization ordering under locks | email, modes, providers, hold-reason meanings | producer → review runner; dispatch → send handler; supersede scope → ownership, ingest and policy units of work; operator → routes and Ray | `customerReplyDelivery` (route), repositories, registered channel scopes |
| `customerReplyDelivery/deliveryFailures.ts` | open and cleared delivery failures | provider specifics | recorder → keystones; reader → routes and Ray | repository |
| `chat/services/conversationIngestService.ts` | recording a customer message with initial ownership, atomically | channels | `ConnectorChatPort.ingest` | repositories, ownership scope, held-reply supersede scope |
| `chat` `review()` | running a turn that returns a draft | channels | `ConnectorChatPort.respond` | existing turn machinery |
| `operatorCopilot/tools/emailChannel.ts` | read projections | mutations, raw content, tokens | Ray catalog, operator MCP | keystone Copilot view, handoff operator port |

Direction holds: plugin and composition → keystone, ports, handoff; keystone → handoff public; handoff never imports email; mail imports nothing from modules.

**Where file count was reduced**:
- One repository per aggregate.
- One webhook route.
- One worker for all stages.
- Review queue and generation counter as columns.
- Held replies and delivery failures extend existing modules.
- One Resend helper and one MIME normalizer.
- One activity-kind widening instead of three.
- R3 removes a duplicate class.
- `ChatResponse` is not touched.

## Observability

New runtime paths:
- webhook receipt;
- inbound stages (fetch, normalize, classify, route, resolve and reserve, ingest, index);
- review turn and publication;
- held-reply lifecycle, including auto queue, materialize and return;
- `email.send` and fenced transitions;
- reconciliation;
- domain refresh;
- scheduled drains;
- sweep.

They get (catalogue in `contracts/events.md`):
- **Logs**: failure, skip and degradation lines only, ids and codes only.
- **Metrics**: bounded-enum labels covering webhook results and latency, deliveries by classification, disposition and reason, review results with grounding and coverage, publication decisions, budget hits, send-intent states, provider-call results, transition conflicts, drain requests, readiness transitions, the backlog gauge and held-reply transitions.
- **Spans**: around every external call and decision, carrying workspace, conversation, delivery, send-intent and held-reply ids.
- **Audit events**: domain, mailbox and policy lifecycle; raw view; retry; held reply created, released, edited, discarded, superseded, auto queued, auto materialized and auto returned; delivery failure opened, acknowledged, resolved and provider evidence; ownership hand-off for the new reasons.
- **Alerts**: inbound stuck, reviews overdue, webhook auth failing, uncertain sends, domain readiness lost, bounce spike, idempotency body mismatch. Runbooks in `docs/email-channel.md#operations`.
- **Never logged, anywhere**: subjects, bodies, quoted or draft text, addresses, display names, raw headers, relay and thread tokens, provider bounce messages, prompts, completions, keys, secrets. This covers every mail driver, including `log` and `noop` for `channel_reply`.

## Message-Queue Impact

- **Document worker and AMQP**: unchanged.
- **Action outbox**: new type `email.send` on `routine_action_requests`, using the existing lease, attempts and backoff. Payload v1 carries ids, the trigger and an authority snapshot (ports §7a). Three key formats. At-least-once delivery, with provider idempotency equal to the outbox key. Unknown outcomes are owned by the fenced reconciler (research B18). `recordFailureOutcome` settles `failed` or `uncertain`.
- **Durable inbound job (not AMQP)**: `email_inbound_events` (stage 1) and `email_thread_links.review_*` (stage 2), claimed with `SKIP LOCKED` and leases, with per-stage attempts and backoff and a visible terminal failure with a retry action.
- **Cloud Tasks**:
  - queue `email_channel`, low max concurrency, drain body `{ maxJobs, stage }`;
  - **scheduled** drains at `review_due_at`, the next retry time and the next re-POST time, through the R3 dispatcher's `scheduleAt` (research B7);
  - scheduler `email_channel_sweep` every 5 min for recovery, refresh, reconciliation claims and retention.

  Locally, the interval loop drains, and a runtime-startup test asserts both runtimes are wired.
- **Connector contract**: `ingest` and `respond` are synchronous in-process calls. `answer` is unchanged, and `connectorPlugin.d.ts:32` stays accurate.
- **Queue tests**: payload schema contract; idempotent enqueue and redelivery; crash between accept and record; lease reclaim; drain-push failure recovered by the sweep; scheduled drain at the due time.
- **Queue docs**: `docs/email-channel.md#queues`, the `docs/human-takeover.md` outbox section and `docs/monitoring-alerts.md`.

## Rollout and Rollback

1. **S0 go/no-go** (Questions settled, Q3) before any S1 adapter merges.
2. **Additive schema.** Migrations 209–214 ship with S1. Before deploying 214, check the `conversation_activity` row count; above 100k rows, pre-create `conversation_activity_workspace_closed_v2_idx` `CONCURRENTLY` (runbook). Workers ship disabled (`EMAIL_CHANNEL_WORKERS_ENABLED=false`, `EMAIL_CHANNEL_PROVIDER` unset).
3. **Infrastructure per region.** Terraform applies before the image: `email_channel` queue, `email_channel_sweep`, secrets and env. Operations registers the relay domain with receiving in each region's provider account and points the webhook. EU waits on S0 T012.
4. **Settings, Inbox APIs and UI** (S1, then S2), with `supportedModes = ["operator_only"]`.
5. **`operator_only` pilot**: one forwarded mailbox, one week, watching backlog, stuck-event and auth alerts.
6. **Operator sending** after the pilot domain verifies (S2). Migration 217 drops the old closing index.
7. **`draft`** (S3 + S4), gated on SC-004, the outcome table, the held-reply visibility suite, the journeys and SC-006 in staging.
8. **`auto`** (S6), only after drafts have been reviewed, every non-publish outcome-table row passes, and the mailbox owner opts in explicitly.

**Rollback**: disable workers, which stops processing and sends while webhooks still persist. Disable mailboxes as needed. Never drop tables. Never auto-replay `uncertain` sends. Rolling back below S3 leaves held replies readable but not releasable. Rolling back below S6 turns `queued_auto` rows back to `pending` through the sweep (`authority_changed`), so nothing is sent without an operator.

## Phase ordering

| Slice | Stories / FRs | Delivers | New seams landing here | Tests written first |
|---|---|---|---|---|
| **S0 Provider spike** | Assumptions; research A2–A9 | Recorded fixtures; go/no-go (Q3) | none | none |
| **R3, then S1 Connect and receive durably** | US1, US2 (P1); FR-001–003, 005–016, 018, 021, 038, 041–045 (receive side) | mailboxes and domains API and card; relay and direct routing; setup check; durable webhook; inbound stages with the thread protocol; human-owned ingest; event log and raw view; conversation email facts and header; Ray read tools 1–3; migrations 209–214; Terraform | receiver, provisioner, normalizer; `ingest`; `ConversationIngestUnitOfWork`; `requestHumanOwnership`; `email` context; worker in both runtimes; scheduled drain port; policy history; `supportedModes`; deliverer (refusing) | classification, routing, thread protocol, disposition; corpus SC-002 interleavings (i)–(vii); SC-003; webhook contract; ingest idempotency; crash recovery (inbound); governance registries |
| **S2 Operator replies** | US3 (P2); FR-004, 031–037, 039, 040 | operator send; send intents with fence; bounces and DSNs; reconciliation including late evidence; `delivery_failed` (backend, Ray triage source, frontend); migrations 215–217 | `EmailDriver` extension; email deliverer route; `email.send` handler; delivery-failure ports | header validation; authority matrix; transition table with version fence; one provider accept per intent; late-evidence transitions; redaction |
| **R1, R2, then S3 Agent drafts** | US4 (P2); FR-017, 019, 020, 024, 026–030 | `review()` with discriminated completion; `respond` with facts; review runner with revision protocol and scheduled wakeups; held replies with release, edit and discard; supersede capabilities in ownership, ingest and policy scopes; `approval` source; Ray `held_replies`; migration 218 | `TurnExecutionMode` `review`; `ChatReviewResult`; `ConnectorTurnFacts`; held-reply ports and scopes; `heldReplyUnitOfWork`; `mailboxPolicyChange` | capability table; no assistant row in review; facts mapper on real fixtures; publication order; concurrent release; held-reply visibility on every surface; stale-worker completion |
| **S4 Bounds** | US5; FR-015, 022, 023, 025 | generation budget per revision; coalescing; policy-at-acceptance cap; automated-mail gate | none | SC-006 flood; coalescing; upgrade-does-not-apply-to-accepted mail |
| **S5 Ray and docs completion** | FR-047, FR-044 | Ray eval rows; operator MCP docs; final docs and corpus | none | copilot eval suite |
| **S6 Auto answers** (P4) | US6; FR-020 publish, FR-032 | `queueAuto`, `materializeAuto`, returned-to-pending | `HeldReplyChannelScope` auto members; `HeldReplyDispatchPort` | every outcome-table row (SC-005); authority-change races; crash between queue and materialize; SC-006 thread budget |

S3 and S4 ship together for any workspace that enables `draft`.

## Questions settled

1. **Direct-receiving routing (FR-006a)**: research B20. An address resolves only by the relay rule (token on the inbound domain) or by the direct rule (exact mailbox address on a receiving-verified domain of the mailbox's workspace). Unknown local parts on a direct domain are workspace-attributed `no_mailbox`. Forwarded mail to a non-receiving customer domain never resolves.
2. **Review revision and completion**: research B17. `review_revision` increments per scheduling. Held replies carry `review_ref` (unique). The runner skips the model when `review_ref` already exists. Completion clears due time and lease only `WHERE review_revision = R`. A crash between publish and completion re-claims, finds the ref and completes without a second turn or send.
3. **S0 go/no-go**:
   - **No-go for the relay topology** unless the relay address is recoverable from `received_for` or the raw `Delivered-To` for Google and M365 forwards (T007).
   - **No-go for any agent-authored send (S3 release, S6)** unless the received message carries `Auto-Submitted: auto-generated` (T008). Documenting a stripped header does **not** satisfy FR-034. On no-go, S1 and S2 ship (operator mail carries no header), and agent sending waits for a provider fix or a different provider adapter behind `EmailDriver`.
   - **Go** for Message-ID handling if it is preserved **or** retrievable through `GET /emails/{id}`.
   - **Go** for domains if sending and receiving capabilities are reported separately.
   - **EU rollout no-go** until `eu-west-1` receiving is confirmed or a written residency decision exists (T012). US rollout is unaffected.
   - Plus addressing is go either way, because it is gated by the setup check.
4. **Preventing `draft`/`auto` before S3/S6**: composition exposes `supportedModes`: S1 and S2 `["operator_only"]`, S3 adds `draft`, S6 adds `auto`. The service's default mode is `draft` only when supported, otherwise `operator_only`, so FR-005's default holds from S3. Requests for unsupported modes return `409 engagement_mode_unavailable`. The UI lists only `supportedModes` from `GET …/email-channel`. Deploying S3 never upgrades an existing mailbox; policy history (B16) records each change.

## Accepted deviations (recorded)

All thirteen deviations were accepted on 2026-10-03 and folded into spec.md. They are recorded here for traceability, with the current design:

1. Plus-token `Reply-To` is gated by the `plus_address` setup-check step.
2. The send intent is materialized at first dispatch. For `auto_reply` the outbox commits with the `queued_auto` held reply, and the message commits with its intent (research B9; see Plan review response, item 12).
3. Operator replies on an unverified domain are refused up front (FR-004).
4. Ray mutations are `deferred`, and the ratchet goes from 102 to 111 in S1.
5. A never-issued relay token gives a workspace-less `no_mailbox` delivery.
6. Publication also reads sending readiness and suppressed effects. `sending_not_verified` precedes `draft_mode` (NB-4).
7. No Resend spam verdict.
8. SC-001 is per mail service (M365 policy step, Google confirmation).
9. Mailbox resolution uses relay-domain addresses or, for direct receiving, receiving-verified domains (B20).
10. EU residency is open (S0 T012).
11. The surface is titled "Email channel", with `/email-channel` routes.
12. Definitions:
    - budget renewal at materialization of operator-authorized sends;
    - a fixed one-hour generation window, reserved once per revision;
    - the coalescing window is deployment configuration;
    - ingest reserves no usage;
    - `review_unavailable` on terminal review failure.
13. Unverified provider items are settled by S0 with the go/no-go above.

## Plan review response

Review: `.context/email-channel-plan-review.md` (2026-10-03). One line per finding.

| # | Change made |
|---|---|
| 1 | The facts mapper narrows on `availability: "assessed"` (`conversation-contract/index.d.ts:17`) and maps every `AssistantTurnOutcome` and availability value. It is tested on real `ChatResponse` and `ChatReviewResult` fixtures (research B3). |
| 2 | `CompletedAssistantTurn` becomes `persisted \| draft`. Review goes through a new `ChatService.review()` returning `ChatReviewResult`. `ChatResponse` and the live HTTP contract are untouched. Correlation uses the request message id and the turn id. No assistant id is fabricated (research B2; ports §3). |
| 3 | `HeldReplySupersedeScope` takes reasons `newer_inbound \| takeover \| operator_reply \| policy_changed` and is added to the ownership change, reply, ingest and policy-change scopes. `HeldReplyChannelScope` (policy lock, auto budget, enqueue, authority, materialized record) is implemented by email and bound by composition. Renewal moves to materialization, so `CustomerReplyRoute` and `OperatorReplyService` are unchanged (research B1; ports §4). |
| 4 | Principal policy (tuples and `sessionOnly`), `operationPermissionRequirements`, `copilotCapabilityProvenance`, `operatorMcpDispositions` and the `delivery_failures` triage source are each placed in their slice (openapi-additions §5a; tasks). |
| 5 | The migration matrix adds each forward FK in the migration that creates its target (210 for deliveries, 216 for send intents, 218 for held replies) (data-model.md Migrations). |
| 6 | The activity CHECK is widened once, in three committed migrations (211 add NOT VALID, 212 validate, 213 drop old), with `lock_timeout = '3s'` on the exclusive phases. The closing index is replaced (214) and the old one dropped one slice later (217) (research B19). |
| 7 | R3 keeps `scheduleAt`. Drains are scheduled at `review_due_at`, retry times and re-POST times. The sweep is recovery only (research B7; ports §7b). |
| 8 | Append-only `email_mailbox_policies`. Each delivery stores `accepted_policy_version` (effective at webhook receipt). Execution is capped at the lower autonomy of accepted and current. The bound policy is validated at hold, queue and materialize (research B16). |
| 9 | One durable protocol: resolve and reserve (forward over index and in-flight reservations, reverse over `reference_ids`, token) under the participant lock, then idempotent ingest with planned ids, then index. Interleavings (i)–(vii) are added to SC-002 and SC-007 tests (research B15). |
| 10 | After any unknown outcome, authority changes never halt or re-queue. A revoked authority with an unknown outcome becomes `uncertain`. Auto halts happen only before materialization, so no message and no intent exist. Halted operator sends resend only through the audited path (research B6, B9). |
| 11 | Send intents gain `version` and `reconcile_lease_until`. Every writer uses `transition(id, expectedVersion, event)`. Late provider evidence resolves `uncertain` to `delivered`, `bounced` or `failed` with `provider_evidence`. Automatic resend never happens (research B18; data-model send-intent machine). |
| 12 | Auto publish writes no message. Held content lives only in `held_replies` (`queued_auto`, then `pending` on return) until an authorized materialization writes the message together with its send intent. The visibility suite covers list, recent, count, window, since, history and detail, `message.created`, model context, summaries and Ray transcript (research B9). Residual spec wording: FR-031 "same transaction as the message" holds for operator triggers. For `auto_reply`, the obligation commits with the queued held reply and the message commits with its intent. This needs the coordinator's acknowledgement because spec.md was not edited. |
| NB-1 | `from.name` and `replyTo` keep `null`. The required result fields name every driver and fake (ports §1a). |
| NB-2 | Explicit `EmailChannelCopilotView` with runtime field selection (ports §8). |
| NB-3 | The current held reply is `{ heldReply: … \| null }` in HTTP and MCP. |
| NB-4 | Precedence is authority, then `sending_not_verified`, then `draft_mode`, then `send_budget`, then outcome (ports §6e). |
| NB-5 | The replacement closing index includes the new closing kinds, and the recently-closed query and OpenAPI enum switch with it (research B19). |
| NB-6 | The inventory is corrected to ten migrations and one three-phase widening. The obsolete confirmation gates are removed. |
| NB-7 | R1 acceptance covers suspended routines. R2 covers direct and staged suppression, and the metric rename is dropped from R2. |
