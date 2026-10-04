---

description: "Task list for the Email Channel (1403)"
---

# Tasks: Email Channel (customer-owned domain, operator-gated agent)

**Input**: Design documents from `/specs/1403-email-channel/`

**Prerequisites**: plan.md (revised after the plan review, including "Questions settled" and "Plan review response"), spec.md, research.md (A1–A12, B1–B20), data-model.md, contracts/ (`openapi-additions.md`, `ports.md`, `events.md`), quickstart.md

**Tests**: The backend is TDD. Every implementation task is preceded by a test task that names the exact test file, and that test must be seen failing before the implementation lands. Frontend user-visible behaviour is covered by Playwright journeys. Frontend unit tests cover only non-visual logic (needs-attention merging, catalog resolution, setup-check polling state).

**Organization**: Tasks follow plan.md "Phase ordering": Setup, S0 spike, refactors R3/R1/R2, then S1 (US1+US2, P1), S2 (US3, P2), S3 (US4, P2), S4 (US5), S5 (Ray and docs), S6 (US6, P4), then rollout. Each slice can ship on its own and ends with verification tasks.

**Architecture**: Module ownership follows plan.md "Module Ownership & Seams":
- `mail/`: provider ports and adapters only.
- `emailChannel/`: the keystone.
- `connectors/plugins/email/`: transport, inbound worker and pure inbound decisions.
- `handoff/heldReplies/`: channel-neutral held replies.
- `customerReplyDelivery/deliveryFailures.ts`: `delivery_failed`.
- `app/composition/`: wiring and transaction binding only.

There are no `sourceChannel === "email"` branches in chat, engine or operator-reply code. `ChatResponse`, `OperatorReplyService` and `CustomerReplyRoute` are not modified.

**Contracts and docs**: Each slice that adds endpoints or Ray tools does, in that slice:
- code-first registry, then `generate:openapi`, SDK sync and MCP sync;
- `apiPrincipalRoutePolicy.ts` rows;
- `operationPermissionRequirements.ts` entries;
- `copilotCapabilityProvenance` and `operatorMcpDispositions` entries;
- coverage-map entries.

Message-queue impact is reviewed in S1, S2 and S6. Read `docs/document-writer-prompt.md` before any docs task.

**Conventions**:
- Run one backend test with `cd backend && pnpm exec vitest run <path>`. Run `pnpm run test:unit` once after editing `packages/connector-api` or `packages/conversation-contract`, because `pnpm exec vitest` skips the package builds.
- After each migration, run `cd backend && pnpm run db:types && pnpm run db:schema && pnpm run db:schema:check`.
- Integration tests use quickstart.md §4.
- Before each PR, run `pnpm run lint`, `pnpm run lint:dead-code:ci`, `cd backend && pnpm run lint` (dependency boundaries), `cd backend && pnpm run build` (`tsc`, also after any `lint:fix`) and `pnpm run ci:local -- origin/main`.

## Size at a glance

| Phase | Slice | Tasks | IDs | Ships as |
|---|---|---|---|---|
| 1 | Setup | 6 | T001–T006 | with the first S1 PR |
| 2 | S0 provider spike + go/no-go | 8 | T007–T014 | fixtures and research notes only |
| 3 | R3 / R1 / R2 refactors | 9 | T015–T023 | three behaviour-preserving PRs |
| 4 | S1 connect + receive durably (US1, US2) | 86 | T024–T109 | 4 PRs: schema+pure+ports, inbound worker, settings API+Ray+UI, docs+infra |
| 5 | S2 operator replies (US3) | 44 | T110–T153 | 2 PRs |
| 6 | S3 agent drafts (US4) | 48 | T154–T201 | 3 PRs: review mode, held replies, email pipeline+UI |
| 7 | S4 bounds (US5) | 10 | T202–T211 | ships with S3 |
| 8 | S5 Ray completion + docs | 7 | T212–T218 | 1 PR |
| 9 | S6 auto (US6) | 19 | T219–T237 | 1–2 PRs |
| 10 | Rollout | 10 | T238–T247 | ops checklist |
| | **Total** | **247** | | |

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task).
- **[Story]**: `US1`–`US6` map to spec user stories. `S0`, `R1`, `R2` and `R3` label spike and refactor tasks. Setup and rollout tasks carry no label.
- Dependencies are written "after Txxx" when they are not implied by phase order.

---

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 Add `postal-mime`, `html-to-text` and `sanitize-html` (plus `@types/html-to-text` and `@types/sanitize-html` as dev dependencies) to `backend/package.json` with `pnpm --filter backend add`. Commit `pnpm-lock.yaml` and record the licenses in the PR.
- [x] T002 [P] Write failing tests in `backend/tests/unit/runtime-config.test.ts`:
  - `EMAIL_CHANNEL_*` unset → channel unconfigured;
  - `EMAIL_CHANNEL_PROVIDER=resend` without `RESEND_CHANNEL_API_KEY` → startup error;
  - the inbound domain is lowercased;
  - defaults: coalesce 60, raw cap 2097152, retention 30, review attempts 4, workers disabled.
- [x] T003 Add the quickstart.md §1 variables to `backend/src/app/config/env.ts` (after T002).
- [x] T004 [P] Add the variables with comments to `.env.example` beside `:242-248`, and add `backend/.email-spool/` to `.gitignore`.
- [x] T005 [P] Create `backend/tests/fixtures/email-channel/mime/`: `first-contact.eml`, `pre-reply-follow-up.eml`, `header-threaded-reply.eml`, `token-only-reply.eml`, `two-mailbox.eml`, `participant-mismatch.eml`, `out-of-order-parent.eml` / `out-of-order-child.eml`, `html-only.eml`, `gmail-quoted-reply.eml`, `outlook-quoted-reply.eml`, `apple-quoted-reply.eml`, `non-english-quoted-reply.eml`, `attachments.eml`, `encoded-word-subject.eml`, `iso-8859-1-body.eml`, `direct-receiving.eml`. Use `example.test` addresses, and list each file's purpose in `backend/tests/fixtures/email-channel/README.md`. The threading files are finalized by T010.
- [x] T006 [P] Create `backend/tests/fixtures/email-channel/protocol/`: `auto-submitted-auto-replied.eml`, `auto-submitted-no.eml`, `precedence-bulk.eml`, `precedence-list.eml`, `precedence-junk.eml`, `x-auto-response-suppress.eml`, `list-id.eml`, `dsn-radioso-id.eml`, `dsn-foreign-id.eml`, `self-sender.eml`.

---

## Phase 2: S0 Provider spike and go/no-go (fixtures and research notes only)

**Purpose**: settle the UNVERIFIED items and apply the go/no-go rules in plan.md "Questions settled", item 3. Run once against a Resend test account and throwaway Google Workspace and M365 tenants (quickstart.md §6).

- [ ] T007 [S0] **Is the relay address visible for forwarded mail?**
  - Question: does `email.received` `received_for`, or the raw `Delivered-To` / `X-Original-To`, carry the relay address for Google and M365 auto-forwards (research A2)?
  - How: register a test relay domain with receiving, forward a base mailbox from each tenant, and save the webhook body, the receiving-API body and the raw `.eml`.
  - Go/no-go: **no-go for the relay topology** if neither source carries the relay address.
  - Blocks: T054, T066, T083.
  - **Result (2026-10-03)**: Direct delivery recorded (research A2); forwarded case blocked on Google Workspace and M365 tenants. Receiving address provisioned: `87164684@rexuatrena.resend.app`.
- [x] T008 [S0] **Does Resend keep our headers?**
  - Question: does Resend keep a supplied `Message-ID` and pass `Auto-Submitted` through (research A7)?
  - How: `POST /emails` with `headers: { Message-ID, Auto-Submitted, In-Reply-To, References }` to a test mailbox. Inspect the raw message received and compare `GET /emails/{id}` `message_id`.
  - Go/no-go: Message-ID is go if preserved **or** retrievable. `Auto-Submitted` stripped is **no-go for every agent-authored send** (S3 release, S6). Documenting the stripping does not satisfy FR-034.
  - Blocks: T116, T120, and the S3 agent-send gate in T173 and T191.
  - **Result (2026-10-03)**: **Go.** Message-ID is replaced by SES but retrievable via `GET /emails/{id}`; `Auto-Submitted`, `In-Reply-To`, `References` pass through verbatim (research A7).
- [ ] T009 [S0] **Does plus addressing survive forwarding?**
  - Question: does `support+tok@tenant` reach the base mailbox and get forwarded on default settings, and is the tag visible at the relay? What does Google's forwarding-confirmation mail look like at the relay (research A9)?
  - How: send externally to the plus address on both tenants, and start a Gmail forwarding setup to the relay.
  - Go/no-go: go either way, because plus addressing is gated by the setup check.
  - Blocks: T062 (`plus_address` step) and T117 (`Reply-To` gating).
  - **Result (2026-10-03)**: Blocked on tenants (research A9).
- [ ] T010 [S0] **Do forwarders keep threading headers?**
  - Question: do the forwarders keep `Message-ID`, `From`, `To`, `In-Reply-To` and `References` on automatic forward (research A9)?
  - How: reply externally to a T008 message and let each tenant forward it.
  - Go/no-go: go either way. Rewrites fall back to the plus token, then to a new thread.
  - Blocks: final threading fixtures in T005, and T067 and T068.
  - **Result (2026-10-03)**: Blocked on tenants (research A9).
- [x] T011 [S0] **What do the Domains API payloads look like?**
  - Question: what are the exact `capabilities`, per-record status and status values, and the "already registered" error (research A4)?
  - How: create, get and verify a domain with sending only, then with receiving, plus a domain held by a second account.
  - Go/no-go: go if sending and receiving are reported separately.
  - Blocks: T055.
  - **Result (2026-10-03)**: **Go.** Sending and receiving reported separately; payloads and duplicate error recorded (research A4); cross-account claim error unverified.
- [x] T012 [S0] **Which regions support Receiving?**
  - Question: does `eu-west-1` support Receiving (research A8, plan Accepted deviations, item 10)?
  - How: create a receiving domain in `eu-west-1`, or get a written answer from Resend.
  - Go/no-go: **EU rollout is no-go** without confirmation or a written residency decision. US is unaffected.
  - Blocks: T246.
  - **Result (2026-10-03)**: **Technical go** for `eu-west-1` receiving MX. **Residency decision open**: Resend stores all account data in the US regardless of region (research A8).
- [x] T013 [S0] **How do signing and delivery events behave?**
  - Question: what is the `whsec_` format, does a dashboard replay mint a new `svix-id`, and what do `email.bounced`, `email.suppressed`, `email.delivered` and `email.failed` contain (research A3, A6)?
  - How: trigger each event and replay one.
  - Output: sanitized JSON in `backend/tests/fixtures/email-channel/webhooks/resend/`, and spam, auth-failed and unknown variants in `backend/tests/fixtures/email-channel/protocol/adapter-verdicts.json`.
  - Blocks: T054 and T121.
  - **Result (2026-10-03)**: `whsec_` format, retry schedule, and event payloads recorded from live probes and docs (research A3, A6); replay-id behaviour unverified. Fixtures under `backend/tests/fixtures/email-channel/resend/`.
- [ ] T014 [S0] Record every answer and the go/no-go result in the matching "Open risk" lines of `specs/1403-email-channel/research.md` (A2, A3, A4, A7, A8, A9), and commit the sanitized fixtures. **Gate**: T054, T055, T116 and T121 cannot merge before this task. A relay no-go stops S1 and goes back to the coordinator. An `Auto-Submitted` no-go stops T173, T191 and Phase 9.
  - **Result (2026-10-03)**: research A1–A8 updated and fixtures committed; A9 and the forwarded-mail half of A2 remain. Gate stays open for T054, T066, and T083 only; T055, T116, and T121 are unblocked.

---

## Phase 3: Refactors (behaviour-preserving, one PR each)

R3 blocks T088 (S1 drain wiring). R1 and R2 block S3 and can run in parallel with S1 and S2.

### R3: shared Cloud Tasks drain dispatcher with `scheduleAt`

- [x] T015 [P] [R3] Write `backend/tests/unit/cloud-tasks-drain-dispatcher.test.ts` for a generic `CloudTasksDrainDispatcher<Body>`: task path, worker-token header, OIDC audience, JSON body, `scheduleTime` set only when `scheduleAt` is in the future (preserving `cloudTasksFacetExtractionDrainDispatcher.ts:37-45`).
- [x] T016 [R3] Implement `backend/src/shared/infra/cloudTasksDrainDispatcher.ts`. Reduce `backend/src/modules/chat/infra/cloudTasksActionDrainDispatcher.ts` and `backend/src/modules/facets/infra/cloudTasksFacetExtractionDrainDispatcher.ts` to wrappers. `cloud-tasks-action-drain-dispatcher.test.ts`, `action-drain-dispatcher.test.ts` and the facet tests pass unchanged (after T015).
- [x] T017 [R3] Verify: `cd backend && pnpm run lint`, `pnpm run lint:dead-code:ci`, `pnpm run test:unit`.

### R1: execution capabilities and the discriminated completion result

- [x] T018 [P] [R1] Write `backend/tests/unit/chat/turn-execution-capabilities.test.ts`:
  - a table pinning every `live` and `safe_test` capability (`routines`, `completion`, `ownershipHandoff`, `turnActions`, `humanOwnedWaitingMessage`; ports §3);
  - routine activation **and** the suspended-routine short-circuit (`chatService.ts:933`) behave as before in both modes;
  - a type-level assertion that `CompletedAssistantTurn` has a `persisted` arm.
- [x] T019 [R1] Add `TurnExecutionCapabilities` and `turnExecutionCapabilities()` to `backend/src/shared/domain/turnExecutionMode.ts` for `live` and `safe_test` (after T018).
- [x] T020 [R1] Replace the `safeTestTurn` boolean in `backend/src/modules/chat/services/chatTurnLifecycle.ts:669-787`, and the mode comparisons in `backend/src/modules/chat/services/chatService.ts` (including `:913-942`), with capability reads. Turn `CompletedAssistantTurn` (`chatTurnLifecycle.ts:152-156`) into a union with only the `persisted` arm, and update its call sites (`chatService.ts:953,1061,1130,1434`, `approvalResumeTurn.ts:192`). `chat-turn-lifecycle.test.ts`, `skill-effect-policy.test.ts`, `chat-session-preparer-skill-effects-and-durability.test.ts` and `workbench-replay-runner.test.ts` pass unmodified (after T019).

### R2: suppressed-effects collector

- [x] T021 [P] [R2] Extend `backend/tests/unit/agent-skill-turn-skill-provider.test.ts`:
  - the provider exposes a per-turn `suppressedEffects()` collector;
  - it records direct turn-skill suppression (`agentSkillTurnSkillProvider.ts:309-311`) and staged-tool suppression (`:386-392`);
  - it is empty for `live`;
  - the persisted reason `suppressed_for_safe_test` and the counter `agent_skill_safe_test_dispatch_total` are unchanged.
- [x] T022 [R2] Implement the collector in `backend/src/app/composition/builtIn/agentSkillTurnSkillProvider.ts` with no rename (after T021).
- [x] T023 [R1] [R2] Verify: `pnpm run test:unit`, `pnpm run lint`, `pnpm run lint:dead-code:ci`, `cd backend && pnpm run build`, and `cd backend && pnpm run evals:copilot` (one-sample smoke) for unchanged safe-test probes.

**Checkpoint**: `live` and `safe_test` behave byte for byte as before. The capability seam, the completion union and the collector are ready for `review`.

---

## Phase 4: S1 Connect a mailbox and receive durably (User Stories 1 and 2, Priority: P1) 🎯 MVP

**Goal**: an operator adds `support@customer.com` in `operator_only` mode, forwards it to the relay address (or, as an advanced option, verifies direct receiving), and passes the setup check. Forwarded mail lands durably in the Inbox as human-owned conversations with correct threading, and every non-conversation event is visible in the mailbox event log. The sending domain registers and verifies. Sending itself ships in S2.

**Independent Test**: spec US1 and US2 "Independent Test", including the SC-002 interleavings (i)–(vii) from research B15 and a worker killed at every inbound stage boundary.

**Mode gate**: `supportedModes = ["operator_only"]` and the default mode is `operator_only` (plan, Questions settled, item 4).

### Schema and activity kinds

- [x] T024 [P] [US2] Write failing tests:
  - `backend/tests/integration/conversation-activity-kinds.integration.test.ts`:
    - after 211–213, the five new kinds insert and unknown kinds are still rejected;
    - 211 and 213 contain `SET LOCAL lock_timeout` (asserted on the SQL text);
    - `conversation_activity_workspace_closed_v2_idx` exists with the extended predicate;
    - the recently-closed query uses it (`EXPLAIN`).
  - `backend/tests/unit/conversation-activity-kinds.test.ts`: presentation for `channel_exception`, `delivery_failed`, `delivery_failure_cleared`, `held_reply_released`, `held_reply_discarded`, and the closing-kinds list.
- [x] T025 [US1] Create `backend/src/db/migrations/209_email_channel_keystone.sql`: `email_domains`, `email_mailboxes`, `email_mailbox_policies`, `email_thread_links`, `email_thread_messages`, with no FK on `inbound_delivery_id` or `send_intent_id` (data-model.md matrix).
- [x] T026 [US2] Create `backend/src/db/migrations/210_email_inbound_events.sql`: `email_inbound_events`, `email_inbound_deliveries` (including the GIN on `reference_ids` and the reservation index), plus `ALTER TABLE email_thread_messages ADD CONSTRAINT … FOREIGN KEY (inbound_delivery_id)`.
- [x] T027 [US2] Create the three-phase widening (research B19):
  - `backend/src/db/migrations/211_conversation_activity_kind_v2_add.sql`: `SET LOCAL lock_timeout='3s'`, `ADD CONSTRAINT conversation_activity_kind_v2_check … NOT VALID` with all five new kinds;
  - `212_conversation_activity_kind_v2_validate.sql`: `VALIDATE CONSTRAINT`;
  - `213_conversation_activity_kind_drop_v1.sql`: `SET LOCAL lock_timeout='3s'`, `DROP CONSTRAINT conversation_activity_kind_check`.
- [x] T028 [US2] Create `backend/src/db/migrations/214_conversation_activity_closed_idx_v2.sql` (`SET LOCAL lock_timeout='3s'`; `CREATE INDEX IF NOT EXISTS … WHERE kind IN (…, 'held_reply_released', 'delivery_failure_cleared')`). Extend `CONVERSATION_ACTIVITY_KINDS` and `CLOSING_ACTIVITY_KINDS` in `backend/src/modules/conversationActivity/contracts/index.ts:8-26`, the presentation in `backend/src/modules/conversationActivity/presentation.ts`, and the recently-closed query in `backend/src/modules/conversationActivity/readService.ts` to match the v2 predicate (after T024).
- [x] T029 Regenerate `backend/src/shared/infra/kysely/schema.ts` (`db:types`) and `backend/src/db/schema.sql` (`db:schema`), then run `db:schema:check` (after T025–T028).

### Tests first: pure decisions and content

- [x] T030 [P] [US1] Write `backend/tests/unit/email-channel/relay-tokens.test.ts`: tokens are 26-character base32 from at least 128 bits; relay and plus-token parsing; customer-domain addresses never parse as relay addresses.
- [x] T031 [P] [US1] Write `backend/tests/unit/email-channel/receiving-state.test.ts` for the `waiting`, `ok` and `silent` boundaries.
- [x] T032 [P] [US1] Write `backend/tests/unit/email-channel/mailbox-routing.test.ts` for research B20:
  - the relay rule (current and previous token);
  - the direct rule (exact address on a receiving-verified domain, `+tag` removed);
  - `direct_unknown` attribution;
  - a customer domain without direct receiving → `null`;
  - a never-issued token → `relay_unknown`.
- [x] T033 [P] [US1] Write `backend/tests/unit/email-channel/effective-mode.test.ts`: the lower autonomy of accepted and current wins, and enabled requires both (research B16).
- [x] T034 [P] [US2] Write `backend/tests/unit/email-channel/inbound-classification.test.ts`:
  - every `protocol/` fixture, plus `adapter-verdicts.json` after T013, maps to its classification;
  - order is self_sender, bounce, automation headers, spam;
  - `Auto-Submitted: no` gives `person`;
  - auth failures never change the result;
  - a body containing automation-like words still gives `person`.
- [x] T035 [P] [US2] Write `backend/tests/unit/email-channel/thread-resolution.test.ts` (pure `resolveThread`, ports §6c):
  - forward index vs reservation;
  - reverse reference;
  - token;
  - participant mismatch;
  - conflict;
  - new thread.
- [x] T036 [P] [US2] Write `backend/tests/unit/email-channel/engagement-disposition.test.ts`: the rule order in ports §6d over `effectiveMode`, every drop and ingest-only reason, `noteOnThread`, spam opt-in, and that `run_review_turn` needs draft/auto, a person, `ai_owned` and an unexhausted budget.
- [x] T037 [P] [US2] Write `backend/tests/unit/email-channel/quoted-history.test.ts` over the corpus: confident vs full text, `>`-block plus trailing-colon line, sig-dash, verbatim cut of prior outbound text, no word lists.
- [x] T038 [P] [US2] Write `backend/tests/unit/email-channel/customer-text.test.ts`: HTML-only body, ISO-8859-1, encoded-word subject, empty body.
- [x] T039 [P] [US2] Write `backend/tests/unit/email-channel/raw-message-view.test.ts`: script, handler, form, remote-resource and CSS `url()` stripping; `cid:` placeholders; relay and plus-token headers hidden; truncation flag.
- [x] T040 [P] [US2] Write `backend/tests/unit/mail/inbound-mime-normalizer.test.ts` for the `InboundEmailMessage` fields (ports §1b), DSN `originalMessageIds`, the attachments manifest and the `deliveredTo` union.
- [x] T041 [P] [US2] Extend `backend/tests/unit/conversation-source.test.ts`: `callerKindForSourceChannel("email") === "human"`, and `AGENT_SOURCE_CHANNELS` is unchanged.

### Implementation: pure decisions, content, mail ports

- [x] T042 [P] [US1] Implement `backend/src/modules/emailChannel/mailboxes/relayTokens.ts` (after T030).
- [x] T043 [P] [US1] Implement `backend/src/modules/emailChannel/mailboxes/receivingState.ts` (after T031).
- [x] T044 [P] [US1] Implement `backend/src/modules/emailChannel/mailboxes/mailboxRouting.ts` (after T032).
- [x] T045 [P] [US1] Implement `backend/src/modules/emailChannel/mailboxes/effectiveMode.ts` (after T033).
- [x] T046 [P] [US2] Implement `backend/src/modules/connectors/plugins/email/emailInboundClassification.ts` (after T034).
- [x] T047 [P] [US2] Implement `backend/src/modules/connectors/plugins/email/emailThreadResolution.ts` (after T035).
- [x] T048 [P] [US2] Implement `backend/src/modules/connectors/plugins/email/emailEngagementDisposition.ts` (after T036).
- [x] T049 [P] [US2] Implement `backend/src/modules/emailChannel/content/quotedHistory.ts` (after T037).
- [x] T050 [P] [US2] Implement `backend/src/modules/emailChannel/content/customerText.ts` (after T038, T049).
- [x] T051 [P] [US2] Implement `backend/src/modules/emailChannel/content/rawMessageView.ts` (after T039).
- [x] T052 [US2] Create the ports `backend/src/modules/mail/inboundEmailReceiver.ts` and `backend/src/modules/mail/emailDomainProvisioner.ts`, and `backend/src/modules/mail/inboundMimeNormalizer.ts` (postal-mime). Export them from `backend/src/modules/mail/public.ts` (after T040).

### Adapters (tests first)

- [x] T053 [P] [US2] Write `backend/tests/unit/mail/local-email-adapters.test.ts`: local verify with the current and `_PREVIOUS` secrets; spool fetch, where a missing file is non-retryable; the local provisioner's pending and verify flip.
- [x] T054 [P] [US2] Write `backend/tests/unit/mail/resend-inbound-receiver.test.ts` over the S0 fixtures (after T007, T013, T014):
  - signature cases;
  - event-kind mapping;
  - fetch via the receiving API and the raw download;
  - retryable vs non-retryable errors;
  - auth mapping;
  - `spamVerdict` is always `unknown`.
- [x] T055 [P] [US1] Write `backend/tests/unit/mail/resend-domain-provisioner.test.ts` (after T011, T014): record and capability mapping, `partially_verified`, `claimed_elsewhere`, tracking disabled, advisory DMARC through an injected resolver.
- [x] T056 [US2] Create `backend/src/modules/mail/adapters/resendApi.ts`, the shared fetch, auth, timeout and error-classification helper (before T057, T058).
- [x] T057 [P] [US2] Implement `backend/src/modules/mail/adapters/resendInboundReceiver.ts` (after T054, T056).
- [x] T058 [P] [US1] Implement `backend/src/modules/mail/adapters/resendDomainProvisioner.ts` (after T055, T056).
- [x] T059 [P] [US2] Implement `backend/src/modules/mail/adapters/localInboundReceiver.ts` and `localDomainProvisioner.ts` (after T053).

### Tests first: persistence, services, protocol, worker, HTTP, Ray

- [x] T060 [P] [US1] Write `backend/tests/integration/email-channel-persistence.integration.test.ts`:
  - active domain unique across workspaces; mailbox address unique;
  - relay and previous-token resolution with grace;
  - policy history append and effective-at lookup;
  - event dedupe on both keys; per-mailbox delivery uniqueness;
  - `SKIP LOCKED` claims and lease reclaim;
  - forward-reservation and reverse (`reference_ids` GIN) lookups scoped by mailbox;
  - event-log paging;
  - retention purge of conversation-less deliveries only.
- [x] T061 [P] [US1] Write `backend/tests/unit/email-channel/sending-domain-service.test.ts`:
  - registration on the first mailbox;
  - a single `claimed_elsewhere` refusal from a database or provider conflict, naming no workspace;
  - refresh cadence;
  - readiness audit;
  - receiving requires typed confirmation;
  - removal revokes first and cleans up asynchronously.
- [x] T062 [P] [US1] Write `backend/tests/unit/email-channel/mailbox-service.test.ts` (after T009 for real tenant behaviour):
  - create registers the domain, issues a token, writes policy version 1 and applies defaults;
  - `supportedModes` gating returns `409 engagement_mode_unavailable`, and the default is `operator_only` while `draft` is unsupported;
  - mode, enabled and agent changes go through the policy-change port (new version plus history row), and a stale `expectedPolicyVersion` gives 409;
  - rotation grace;
  - setup check `base` and `plus_address` (sets `plus_address_verified_at`);
  - audit events.
- [x] T063 [P] [US2] Write `backend/tests/unit/chat/conversation-ingest-service.test.ts`:
  - caller ids, one unit of work, idempotent retry (`messageCreated: false`);
  - `humanOwnership` goes through `requestHumanOwnership` in scope, and only hands off when `ai_owned`;
  - an existing conversation with `kind: "new"` and the same id is a no-op;
  - no usage reservation; invalidation after commit;
  - `visitor_id` and `verified_customer_id` stay null.
- [x] T064 [P] [US2] Extend `backend/tests/unit/handoff/conversation-ownership-service.test.ts`: `requestHumanOwnership(scope, …)` writes `human_owned` with the reason and a `handoff_requested` activity in the scope, and is a no-op when already human-owned.
- [x] T065 [P] [US2] Extend `backend/tests/unit/connectors/connectorChatPort.test.ts`: `ingest` delegates, and `answer` is unchanged.
- [x] T066 [P] [US2] Write `backend/tests/unit/email-channel/inbound-processor.test.ts` with fakes (after T007):
  - routing through `mailboxRouting` only (relay or direct);
  - `accepted_policy_version` taken from the event's `received_at`;
  - fan-out per mailbox;
  - fetch retry schedules a drain at `next_attempt_at`, then terminal `failed` with a retry action;
  - the protocol order resolve → ingest → index, with planned ids persisted at `resolved`;
  - drops on existing threads record `channel_exception`;
  - `operator_only` ingests with `operator_only_mailbox`;
  - a participant mismatch is an exception and no turn;
  - `last_received_at` updated;
  - no `run_review_turn` is reachable under S1 `supportedModes`.
- [x] T067 [US2] Write `backend/tests/integration/email-thread-protocol.integration.test.ts` covering research B15 interleavings (i)–(vii) with two concurrent workers and the out-of-order fixtures (after T010). Each case asserts the expected single conversation, or two for the two-mailbox case.
- [x] T068 [US2] Write `backend/tests/integration/email-inbound.integration.test.ts`, end to end with the local receiver:
  - the SC-002 corpus;
  - a never-issued token gives a workspace-less `no_mailbox`;
  - an unknown address on a direct-receiving domain gives a workspace-attributed `no_mailbox`;
  - `mailbox_disabled`;
  - SC-003: no `protocol/` fixture runs a turn and all of them appear in the event log;
  - mail accepted under policy v1 and processed after v2 runs under the lower autonomy.
- [x] T069 [US2] Write `backend/tests/integration/email-channel-crash-recovery.integration.test.ts` (inbound). A test-only fault hook fires after: event persisted; fetched; resolved and reserved; ingested; indexed. Exactly one message per delivery and no split thread (the inbound half of SC-007).
- [x] T070 [P] [US2] Write `backend/tests/contract/email-webhook.contract.test.ts`, beside `slack-webhook.contract.test.ts`:
  - persisted, 200;
  - duplicate `svix-id`, 200 and no row;
  - replay with a new `svix-id` and the same `email_id`, no row;
  - 401 bad or stale signature, with the body never logged;
  - 400 malformed; 503 database down;
  - no fetch, ingest or turn inline;
  - `unsupported` persisted;
  - local ack under 1 s.
- [x] T071 [P] [US2] Extend `backend/tests/contract/history-channel-context.contract.test.ts`: the `email` context round-trips, with no thread token.
- [x] T072 [P] [US2] Write `backend/tests/unit/email-channel/email-channel-worker.test.ts`: interval start and stop; `drain({ maxJobs, stage })` claims due work only; the disabled flag; sweep lease recovery, refresh and retention.
- [x] T073 [P] [US2] Write `backend/tests/unit/email-channel-worker-task-routes.test.ts`: drain and sweep sit behind the worker token. Mirror `action-dispatch-worker-task-routes.test.ts`.
- [x] T074 [P] [US2] Extend `backend/tests/unit/runtime-startup.test.ts`: both runtimes wire `EmailChannelWorker` when configured and enabled, and neither does otherwise.
- [x] T075 [P] [US1] Write `backend/tests/unit/app-composition/email-channel-composition.test.ts`:
  - `null` when unconfigured;
  - adapter selection;
  - `supportedModes` is `["operator_only"]`;
  - the `email` deliverer refuses with `409 email_sending_not_available`;
  - the scheduled drain dispatcher (Cloud Tasks with `scheduleAt`) vs no-op;
  - `MailboxPolicyChangeUnitOfWork` bound.
- [x] T076 [P] [US1] Write `backend/tests/contract/email-channel-settings.contract.test.ts` for every S1 endpoint in openapi-additions §1 plus `getConversationEmailFacts`:
  - permissions;
  - every documented error, including `domain_claimed_elsewhere` without naming the other workspace and `engagement_mode_unavailable`;
  - `supportedModes` and `defaultMode` in the overview;
  - `relayAddress` only for the caller's own workspace;
  - raw view audit.

  `backend/tests/contract/api-principal-route-policy.contract.test.ts` fails until T090.
- [x] T077 [P] [US1] Write `backend/tests/unit/email-channel/conversation-email-facts.test.ts`: the latest projection and per-message subject, CC, attachments and `rawDeliveryId`; delivery is `null` in S1.
- [x] T078 [P] [US1] Write `backend/tests/unit/operatorCopilot/email-channel-tools.test.ts` for `email_channel_configuration`, `email_channel_events` and `email_conversation_facts`:
  - built on `EmailChannelCopilotView` (ports §8);
  - no `relayAddress`, setup-check recipient, thread token or raw content;
  - object-rooted output schemas;
  - permission filtering.

### Implementation: persistence, services, protocol, worker

- [x] T079 [P] [US1] Implement `backend/src/modules/emailChannel/persistence/emailDomainRepository.ts`, `emailMailboxRepository.ts` (with policy history and effective-at lookup), `emailInboundRepository.ts` (claims, reservation and reverse lookups, event log) and `emailThreadRepository.ts` (link upsert, index insert, review fields), plus the advisory-lock helper (after T029, T060).
- [x] T080 [US1] Implement `backend/src/modules/emailChannel/domains/sendingDomainService.ts`, `mailboxes/mailboxService.ts`, `eventLog/eventLogReader.ts`, `facts/conversationEmailFacts.ts`, `copilot/emailChannelCopilotView.ts` and `public.ts`. Create the S1 form of `backend/src/app/composition/mailboxPolicyChange.ts` (mailbox row lock, version bump, history row; S3 adds supersede) (after T061, T062, T077, T079).
- [x] T081 [US2] Contracts:
  - add `ConnectorIngestInput`, `ConnectorIngestResult` and `ingest` to `packages/connector-api/connectorPlugin.d.ts`;
  - add the `email` variant to `packages/conversation-contract/index.d.ts:95-105` and to `ConversationChannelContextSchema` (`backend/src/app/http/openapi/schemas/assistantHistorySchemas.ts:319-340`).

  Then run `pnpm run test:unit` once (after T065, T071).
- [x] T082 [US2] Implement ownership and ingest (after T063, T064, T081):
  - reasons `operator_only_mailbox`, `generation_budget` and `review_unavailable` in `backend/src/modules/handoff/ownershipState.ts:5-9`;
  - `requestHumanOwnership` in `conversationOwnershipService.ts`;
  - `backend/src/modules/chat/services/conversationIngestService.ts`;
  - `backend/src/app/composition/conversationIngest.ts`;
  - `ingest` in `backend/src/modules/connectors/services/connectorChatPort.ts`.
- [x] T083 [US2] Implement `backend/src/modules/connectors/plugins/email/emailInboundProcessor.ts` (stage 1 with the research B15 steps), readable top to bottom (after T044–T052, T066, T079, T082).
- [x] T084 [US2] Implement `backend/src/modules/connectors/plugins/email/emailWebhook.ts` and `emailPlugin.ts`, mounting `/webhook` and requiring `rawBody` (after T057, T059, T070).
- [x] T085 [US2] Implement `backend/src/modules/connectors/plugins/email/emailChannelWorker.ts` and `backend/src/modules/emailChannel/maintenance/emailChannelSweep.ts` (recovery, refresh, retention) (after T072, T083).
- [x] T086 [US2] Create `backend/src/app/worker/emailChannelWorkerTaskRoutes.ts`, mount it in `createWorkerTaskApp.ts`, and start and stop the loop in `backend/src/runtime/startWorkerRuntime.ts` (after T073, T074, T085).
- [x] T087 [US1] Create `backend/src/modules/emailChannel/operator/emailCustomerReplyDeliverer.ts` in its S1 form, where `route()` refuses with `AppError(409, "email_sending_not_available")`. Register it under `email` in `backend/src/app/server/builders/eval.ts:113-124` (after T075).
- [x] T088 [US1] Compose `backend/src/app/composition/emailChannel.ts` (adapters, plugin, worker, sweep, `supportedModes`, deliverer, policy-change unit of work). Add `createDefaultEmailChannelDrainDispatcher` to `backend/src/app/composition/defaultComposition.ts` on top of `backend/src/modules/emailChannel/infra/cloudTasksEmailChannelDrainDispatcher.ts` (R3, with `scheduleAt`). Accept the plugin in `backend/src/modules/connectors/plugins/index.ts:18-31`. Push drains after the webhook commit and at retry times (after T016, T075, T084–T087).

### HTTP contract and governance

- [x] T089 [US1] Create `backend/src/app/http/routes/emailChannelRoutes.ts` with the settings router and `GET /api/v1/conversations/:conversationId/email`, mounted where `slackConnectionRoutes.ts` is (after T076, T080).
- [x] T090 [US1] Register the contract (after T089):
  - `backend/src/app/http/openapi/paths/emailChannelPaths.ts` and `schemas/emailChannelSchemas.ts`, registered in `openApiPaths.ts`;
  - `backend/src/app/http/apiPrincipalRoutePolicy.ts`: permission tuples for the `/email-channel` routes and `sessionOnly(…, "workspace.conversation.takeover")` for the facts route (openapi-additions §5a);
  - `backend/src/app/http/openapi/operationPermissionRequirements.ts`: `getEmailChannel`, `getEmailMailbox`, `listEmailMailboxEvents` and `getConversationEmailFacts`.

  Then run `cd backend && pnpm run generate:openapi`. This regenerate also carries the `CLOSING_ACTIVITY_KINDS` enum change from T028.
- [x] T091 [US1] Run `cd typescript-sdk && pnpm run sync` and `cd packages/radioso-mcp-server && pnpm run sync:openapi && pnpm run check:openapi`, and commit the generated files (after T090).

### Ray (lands with the endpoints)

- [x] T092 [US1] Create `backend/src/modules/operatorCopilot/tools/emailChannel.ts` with the three read tools over `EmailChannelCopilotView`, and register it in `tools/index.ts` (after T078, T080).
- [x] T093 [US1] Governance and coverage (after T091, T092):
  - provenance entries in `backend/src/modules/operatorCopilot/capabilityProvenance.ts`;
  - read dispositions in `backend/src/modules/operatorCopilot/operatorMcpDisposition.ts`;
  - coverage in `backend/tests/unit/operatorCopilot/catalogCoverage.ts`: S1 reads → tools; `rotateEmailMailboxRelayToken` → `neverListExclusion("secret_rotation")`; 9 mutations → `deferred`; raw view → `permanent`;
  - `maxDeferredCatalogExclusions` from 102 to 111 in `copilot-catalog-coverage.test.ts:68`;
  - `fieldParity.ts`.

  Run `copilot-catalog-coverage`, `copilot-catalog-shape`, `copilot-field-parity`, `copilot-mcp-catalog`, `operator-mcp-catalog` and `operator-mcp-doc-parity`, and update the operator MCP docs they check.

### Frontend

- [x] T094 [P] [US1] Extend `frontend/tests/unit/agent-channel-catalog.test.ts` for the `email-channel` status: `available`, `active`, and `attention` when a mailbox is silent or its domain is unverified.
- [x] T095 [US1] Add the `email-channel` id and entry to `frontend/lib/agent-channel-catalog.ts` (`:1`, `:35-53`), and create `frontend/lib/api-email-channel.ts` (after T091, T094).
- [x] T096 [P] [US1] Write `frontend/tests/unit/email-setup-check-state.test.ts` for the polling state machine: `base` then `plus_address`, and timeout.
- [x] T097 [US1] Implement `frontend/lib/email-setup-check-state.ts` (after T096).
- [x] T098 [US1] Write the Playwright journey `frontend/tests/e2e/email-channel-setup.spec.ts` first, using the local provider and `email:dev`:
  - add a mailbox; relay address with copy; forwarding guidance for Google and M365 (policy step, then rule);
  - receiving `waiting`, then `ok`;
  - per-record DNS copy and status; claimed-elsewhere message;
  - typed confirmation for direct receiving;
  - the mode selector offers only `operator_only`;
  - the event log with retry; the sanitized raw view;
  - an operator-only conversation in the Inbox with its sender and subject header;
  - the composer explains that sending is unavailable;
  - focus kept and async status announced (FR-042).
- [x] T099 [US1] Create `frontend/components/dashboard/settings/email-channel-card.tsx`, `email-domain-records.tsx` and `email-mailbox-events.tsx`, and mount the card in `workspace-assistant-channels-tab.tsx:1051`. It has loading, empty, error, success and partial states, and its modes come from `supportedModes` (after T095, T097, T098).
- [x] T100 [US1] Create `frontend/components/dashboard/inbox/email-conversation-header.tsx`, mounted from `inbox-response-view.tsx` for `provider === "email"`, and add a disabled state with the server reason to `operator-composer.tsx` (after T095, T098).

### Dev tooling, infrastructure, docs

- [x] T101 [P] [US2] Create `backend/scripts/emailChannelDev.ts` (`inbound`, `inbound --replay`, `verify-domain`) and the `email:dev` script in `backend/package.json`. It is dev-only.
- [x] T102 [P] Terraform, then `terraform validate`:
  - `infra/terraform/queue.tf`: an `email_channel` queue with low max concurrency;
  - `scheduler.tf`: `email_channel_sweep`, 5 min, `/internal/tasks/email-channel/sweep`;
  - `secrets.tf`: `RESEND_CHANNEL_API_KEY`, `EMAIL_CHANNEL_WEBHOOK_SECRET`;
  - `compute.tf`: API and worker env, including `EMAIL_CHANNEL_TASK_QUEUE_NAME`;
  - `variables.tf`: workers disabled by default.
- [x] T103 [P] [US1] Create `docs/email-channel.md` after reading `docs/document-writer-prompt.md`. It covers:
  - topology: relay by default, and direct receiving with its routing rule (research B20);
  - forwarding for Google (confirmation through the raw view) and M365 (policy, then rule);
  - DNS records;
  - `operator_only` mode, the event log, retention and raw access;
  - `#queues` (stages, scheduled drains, sweep);
  - `#operations` runbooks, including pre-creating the closing index `CONCURRENTLY` on large tables;
  - how it differs from the customer-email skill.
- [x] T104 [P] [US1] Update the remaining docs:
  - `docs-portal/content/operators/email-channel.mdx` and its `_meta.js` entry;
  - the channel line in `readme.md` (near `:34`);
  - `docs/architecture/code-map.md`;
  - `docs/monitoring-alerts.md` (inbound stuck, webhook auth, domain readiness);
  - `backend/src/modules/visitors/README.md:38-40` (email ingest has no visitor key);
  - `backend/src/modules/emailChannel/README.md`;
  - a one-line pointer in `docs/customer-email-skills.md`.
- [x] T105 [US1] Run `pnpm --dir packages/product-docs run sync` and confirm `sync:check` passes (after T103, T104).

### Verification (S1)

- [x] T106 [US1] [US2] Backend: `cd backend && pnpm run test:unit && pnpm run test:contract && pnpm run test:integration`, then `pnpm run lint`, `cd backend && pnpm run lint`, `pnpm run lint:dead-code:ci` and `cd backend && pnpm run build`.
  - **Result (2026-10-03)**: unit 8010 passed; contract 527 passed; integration 1364 passed after fixing `createIfAbsent`; root lint, backend lint, dead-code ratchet, both DB snapshot checks, product-docs sync, SDK and MCP checks, and `pnpm run build` all pass. The `tsconfig.json` (tests) typecheck has ~95 pre-existing errors in unrelated files.
- [x] T107 [US1] Frontend: `cd frontend && pnpm test && pnpm run build && PLAYWRIGHT_PORT=<free> pnpm run test:e2e -- email-channel-setup`.
  - **Result (2026-10-03)**: frontend unit 1745 passed; production build passed; the full Playwright suite against the production server ran 359 passed, 16 skipped, 1 failed. All four `email-channel-setup` journeys passed. The one failure is `google-login.spec.ts` (callback path rewrite), unrelated to this change and not touched by it.
- [ ] T108 [US1] [US2] Walk through quickstart §2–§3 with the local provider (mailbox, inbound, human-owned conversation, replay with no duplicate), then run `pnpm run ci:local -- origin/main`.
- [ ] T109 [US2] Record the message-queue impact review in the PR: AMQP untouched; inbound job tables; the `email_channel` queue with scheduled drains; the sweep; retry semantics; the queue docs; `connectorPlugin.d.ts:32` still accurate.

**Checkpoint**: S1 is shippable, and the `operator_only` pilot can run (T243).

---

## Phase 5: S2 Operator replies from the Inbox by email (User Story 3, Priority: P2)

**Goal**: an operator's Inbox reply reaches the customer in-thread from `support@customer.com`, exactly once. Bounces, failures and unknown outcomes surface as `delivery_failed` and settle through fenced transitions.

**Independent Test**: spec US3 "Independent Test", plus concurrent webhook, reconciler and handler writers on one intent, and late provider evidence on an `uncertain` intent.

### Schema

- [x] T110 [US3] Create `backend/src/db/migrations/215_conversation_delivery_failures.sql`.
- [x] T111 [US3] Create `backend/src/db/migrations/216_email_send_intents.sql` (with `version` and `reconcile_lease_until`), plus `ALTER TABLE email_thread_messages ADD CONSTRAINT … FOREIGN KEY (send_intent_id)`.
- [ ] T112 [US3] Create `backend/src/db/migrations/217_conversation_activity_closed_idx_v1_drop.sql` (`SET LOCAL lock_timeout='3s'`; `DROP INDEX IF EXISTS conversation_activity_workspace_closed_idx`). It ships only after S1's query switch is live in every region.
  - **Deferred (2026-10-04)**: not created in this release; ship after the S1 query switch is live in every region.
- [x] T113 [US3] Regenerate and check both snapshots (after T110–T112).

### Tests first

- [x] T114 [P] [US3] Write `backend/tests/unit/mail/email-header-values.test.ts`: reject CR, LF, missing brackets, whitespace and display-name injection.
- [x] T115 [P] [US3] Extend `backend/tests/unit/mail/emailService.test.ts`:
  - `channel_reply` redaction in `log` and `noop`;
  - transactional kinds unchanged;
  - `providerMessageId` and `deliveredMessageId` present on every driver result;
  - `lookup` returns `null` on `log` and `noop`;
  - `from.name: null` and `replyTo: null` are still accepted (NB-1).
- [x] T116 [P] [US3] Write `backend/tests/unit/mail/resend-driver.test.ts` (after T008, T014): headers, `Idempotency-Key`, the 409 variants, 5xx and timeout → unknown, 4xx → rejected, `lookup`.
- [x] T117 [P] [US3] Write `backend/tests/unit/email-channel/outbound-headers.test.ts` (after T009): Message-ID domain, threading headers, `References` trimming, `Auto-Submitted` for agents only, `replySubject`, `Reply-To` gated on `plusAddressVerified`.
- [x] T118 [P] [US3] Write `backend/tests/unit/email-channel/send-authority.test.ts` for the operator-trigger first-attempt checks (research B6).
- [x] T119 [P] [US3] Write `backend/tests/unit/email-channel/send-intent-transitions.test.ts` covering every row of the data-model send-intent machine, including:
  - unknown outcome with authority valid → re-POST;
  - unknown outcome with authority revoked → `uncertain`;
  - late provider evidence from `uncertain`;
  - operator resolution;
  - terminal events ignored.
- [x] T120 [P] [US3] Write `backend/tests/unit/email-channel/email-send-action-handler.test.ts` (after T008):
  - intent materialized by key on first claim (for `operator_reply` and `held_release`);
  - revalidation on the first attempt only;
  - the request snapshot frozen;
  - the accept path records the provider id and delivered id (two thread rows when they differ);
  - unknown outcome → scheduled `reconcile` drain at the next re-POST time;
  - no transaction open across the driver call;
  - `recordFailureOutcome` → `failed` or `uncertain` plus a delivery failure;
  - author from `messages.source`;
  - send-budget renewal at materialization for operator-authorized triggers.
- [x] T121 [P] [US3] Write `backend/tests/unit/email-channel/provider-delivery-events.test.ts` (after T013): every provider status, inbound DSN bounce, foreign ids ignored, out-of-order events, and late evidence on `uncertain`.
- [x] T122 [P] [US3] Write `backend/tests/unit/email-channel/send-reconciler.test.ts`: claims with `reconcile_lease_until` (two sweeps never claim the same intent); re-POST inside 23 h; lookup after 24 h → settle or `uncertain`; never a new key.
- [x] T123 [P] [US3] Write `backend/tests/unit/email-channel/email-customer-reply-deliverer.test.ts`:
  - refuses with `409 email_sending_not_verified`, naming the step, when the domain is unverified or removed;
  - when ready, enqueues `email.send` with `email:send:msg:<messageId>` and a payload of ids and authority only.
- [x] T124 [P] [US3] Extend `backend/tests/unit/customer-reply-delivery.test.ts`: provider `email` dispatched by registration; web unaffected.
- [x] T125 [P] [US3] Write `backend/tests/unit/delivery-failures.test.ts`: `open` idempotent per open message; `retarget`; `clear` (`later_delivery`, `provider_evidence`, `operator_resolved`); the reader's agent filter.
- [x] T126 [P] [US3] Extend `backend/tests/unit/operatorCopilot/copilot-needs-attention.test.ts` and `copilot-triage-tools.test.ts`: the `delivery_failed` kind; the `delivery_failures` triage source under `workspace.conversation.takeover`; an unauthorized source reported as a gap.
- [x] T127 [P] [US3] Write `backend/tests/contract/delivery-failures.contract.test.ts`: list, acknowledge, and `resolve` (`marked_sent` for `uncertain` only; `resend` for `uncertain` or `halted` when sending is ready); `sessionOnly` takeover permission; audit `hitl.delivery_failure`.
- [x] T128 [P] [US3] Write `backend/tests/contract/email-send-action.contract.test.ts`: payload v1 (ports §7a) and the key formats.
- [x] T129 [US3] Write `backend/tests/integration/email-send-idempotency.integration.test.ts`:
  - a reply via `POST /api/v1/conversations/{id}/reply` commits the message and `email.send` together;
  - refusal before any write when unverified;
  - redelivery after accept gives one provider accept (the fake driver honours keys);
  - authority revoked before the first attempt → `halted` plus `delivery_failed`, and an audited resend sends once;
  - a bounce webhook → `bounced` plus attention plus sanitized detail;
  - operator mail carries no `Auto-Submitted`;
  - a later customer reply runs no turn (AS3.6).
- [x] T130 [US3] Write `backend/tests/integration/email-send-fencing.integration.test.ts`:
  - concurrent webhook `delivered` and reconciler `lookup` on the same intent → a single final state, with the conflict counted;
  - a stale lookup never overwrites `delivered`;
  - unknown outcome then authority revoked → `uncertain`, with no re-POST.
- [x] T131 [US3] Extend `backend/tests/integration/email-channel-crash-recovery.integration.test.ts` with crashes after: outbox claim; provider accept before record; record before delivered-id fetch. At most one accept per intent (the outbound half of SC-007).

### Implementation

- [x] T132 [P] [US3] Implement `backend/src/modules/mail/emailHeaderValues.ts` (after T114).
- [x] T133 [US3] Extend `backend/src/modules/mail/emailService.ts` (types, required result fields, redaction, `lookup`, `EmailSendError`). Update every `EmailDriver` / `EmailService` fake found by `rg -l "EmailDriver|EmailSendResult" backend/tests` in the same task (after T115, T132).
- [x] T134 [US3] Extend `backend/src/modules/mail/adapters/resendDriver.ts` over `resendApi.ts` (after T116, T133).
- [x] T135 [P] [US3] Implement `backend/src/modules/emailChannel/outbound/outboundHeaders.ts`, `sendAuthority.ts` and `sendIntentTransitions.ts` (after T117–T119).
- [x] T136 [US3] Implement `backend/src/modules/emailChannel/persistence/emailSendIntentRepository.ts` with `transition(id, expectedVersion, event)` and the reconcile claim (after T113, T135).
- [x] T137 [US3] Implement `backend/src/modules/customerReplyDelivery/deliveryFailures.ts` and `backend/src/db/repositories/conversationDeliveryFailureRepository.ts`, export them from `customerReplyDelivery/public.ts`, and record the `delivery_failed` and `delivery_failure_cleared` activities (after T113, T125).
- [x] T138 [US3] Implement `backend/src/modules/emailChannel/outbound/emailSendActionHandler.ts` (after T120, T134–T137).
- [x] T139 [US3] Implement `backend/src/modules/emailChannel/outbound/providerDeliveryEvents.ts`, and route `delivery_status` events and DSN bounces to it from `emailInboundProcessor.ts` (after T121, T138).
- [x] T140 [US3] Implement `backend/src/modules/emailChannel/outbound/sendReconciler.ts`, add its claim step to `emailChannelSweep.ts`, and schedule `reconcile` drains (after T122, T138).
- [x] T141 [US3] Replace the S1 refusal in `emailCustomerReplyDeliverer.ts` with the real route (after T123, T138).
- [x] T142 [US3] Composition: register `email.send` via `actionHandlerRegistrations` (`backend/src/app/server/builders/chat.ts:522-540`) from `backend/src/app/composition/emailChannel.ts`, and add the `delivery` subcommand to `backend/scripts/emailChannelDev.ts` (after T124, T138–T141).
- [x] T143 [US3] Extend `conversation-email-facts.test.ts` first, then `conversationEmailFacts.ts`, with per-message delivery state and the sanitized code.

### HTTP, governance, Ray

- [x] T144 [US3] HTTP (after T127, T137):
  - create `backend/src/app/http/routes/deliveryFailureRoutes.ts` and `openapi/paths/deliveryFailurePaths.ts`;
  - add `sessionOnly` rows in `apiPrincipalRoutePolicy.ts` and `listDeliveryFailures` in `operationPermissionRequirements.ts`;
  - run `generate:openapi`, the SDK `sync` and the MCP `sync:openapi`.
- [x] T145 [US3] Ray (after T126, T144):
  - `delivery_failed` in `backend/src/modules/operatorCopilot/tools/needsAttention.ts` (`:36`, `:42-46`, `:85-120`, `readDeliveryFailureQueue`);
  - the `delivery_failures` source in `triageDigest.ts:43` and `escalationSources.ts:48-55`;
  - coverage: `listDeliveryFailures` → `needs_attention`; `acknowledgeDeliveryFailure` and `resolveDeliveryFailure` → `permanent`;
  - the parity tests.

### Frontend

- [x] T146 [P] [US3] Extend `frontend/tests/unit/needs-attention.test.ts` and `needs-attention-query-state.test.tsx`: delivery-failure rows are critical, counted and in the lenses.
- [x] T147 [US3] Add `'delivery_failed'` and its severity to `frontend/lib/needs-attention.ts:24-35`, create `frontend/lib/needs-attention-reply-review.ts` (builder), add the source in `needs-attention-query-state.ts` beside `:200-213`, and create `frontend/lib/api-reply-review.ts` (after T144, T146).
- [x] T148 [US3] Write the Playwright journey `frontend/tests/e2e/email-operator-reply.spec.ts` first: reply → queued → delivered; refusal when unverified; simulated bounce → `delivery_failed` with detail; acknowledge.
- [x] T149 [US3] Show delivery state per message in `email-conversation-header.tsx`, enable the composer when sending is ready, and add the lens and count in `frontend/components/dashboard/inbox/inbox-lens-toggle.tsx` if lenses enumerate kinds (after T147, T148).

### Docs and verification

- [x] T150 [P] [US3] Docs:
  - `docs/email-channel.md`: sending, headers, `Reply-To` gating, delivery states, uncertain resolution and late evidence, bounce runbook;
  - `docs/human-takeover.md`: email replies, `delivery_failed`, `email.send` beside `slack.post`;
  - `docs/monitoring-alerts.md`;
  - the portal mdx, then a corpus resync.
- [x] T151 [US3] Backend: suites, lint, depcruise, dead code, build.
  - **Result (2026-10-04)**: unit 8454 passed; contract 575 passed; integration 1407 passed on a fresh disposable database; backend lint, root lint, dead-code ratchet, both snapshot checks, product-docs sync, MCP OpenAPI check, and `pnpm run build` pass.
- [x] T152 [US3] Frontend: unit, build, `test:e2e -- email-operator-reply`.
  - **Result (2026-10-04)**: frontend unit 1754 passed; production build passed; `email-operator-reply` journey 7/7 against the production server; `email-channel-setup`, inbox, and sidebar journeys 27/27.
- [ ] T153 [US3] Record the message-queue review: `email.send` on `routine_action_requests` (lease 300 s, 5 attempts, 60 s backoff); the three key formats; fenced reconciliation; scheduled `reconcile` drains. Walk through `email:dev delivery` and run `pnpm run ci:local -- origin/main`.
  - **Result (2026-10-04)**: Message-queue review recorded here for the PR: `email.send` rides the existing action outbox (`routine_action_requests`, lease 300 s, 5 attempts, 60 s backoff) with keys `email:send:msg:<id>`, `email:send:msg:<id>:resend:<n>`, `email:send:held:<id>`; send-intent transitions are version-fenced; `reconcile` drains are scheduled through the shared Cloud Tasks dispatcher with `scheduleAt`; AMQP document-worker payloads are untouched; queue docs updated in `docs/email-channel.md#queues`. `ci:local` and the `email:dev delivery` walkthrough are left for the PR stage.

**Checkpoint**: the Inbox is a working email channel with no agent involvement. T244 is unblocked.

---

## Phase 6: S3 Agent drafts, operator sends (User Story 4, Priority: P2)

**Goal**: on a `draft` mailbox the agent runs one coalesced `review` turn per revision and produces a held reply that operators release, edit and release, or discard. Held content never appears in any customer-visible surface. Requires R1 and R2. S4 ships with it.

**Independent Test**: spec US4 "Independent Test", plus the held-reply visibility suite and a stale-worker revision race.

**Agent-send gate**: T173 and T191 do not merge if T008 found `Auto-Submitted` stripped (plan, Questions settled, item 3).

### Schema

- [x] T154 [US4] Create `backend/src/db/migrations/218_held_replies.sql` (states including `queued_auto`, unique live draft, unique `review_ref`), plus `ALTER TABLE email_send_intents ADD CONSTRAINT … FOREIGN KEY (held_reply_id)`.
- [x] T155 [US4] Regenerate and check both snapshots (after T154).

### Tests first: review mode

- [x] T156 [P] [US4] Extend `backend/tests/unit/chat/turn-execution-capabilities.test.ts` with the `review` row, and `backend/tests/unit/skill-effect-policy.test.ts` with review → `suppressed` even when `allowed` is requested. The `live` and `safe_test` rows are unchanged.
- [x] T157 [P] [US4] Write `backend/tests/unit/chat/review-turn.test.ts` for `ChatService.review()`:
  - reuses `existingUserMessageId` and creates no message;
  - neither routine activation nor suspended-routine resume runs;
  - no assistant row on either persistence path, and completion returns `kind: "draft"` with correlation `{ requestMessageId, turnId }`;
  - the coverage record and an audit event with `executionMode: "review"` are committed;
  - human-owned → `human_owned` with no waiting-message call;
  - the hand-off is reported and ownership unchanged;
  - actions dropped;
  - `suppressedEffects` from both sites, reason `suppressed_for_review`, and `agent_skill_effect_suppressed_total{mode,site}`;
  - the history window is bounded;
  - usage is reserved as `conversation_reply` / `email`;
  - a type test that `answer()` never returns a draft.
- [x] T158 [P] [US4] Write `backend/tests/unit/chat-session-preparer-existing-message.test.ts`: an existing user message is loaded scoped to its conversation and workspace, and a foreign message is rejected.
- [x] T159 [P] [US4] Write `backend/tests/unit/connectors/connectorTurnFacts.test.ts`: every `AssistantTurnOutcome` and every `AnswerCoverageAvailability` (narrowing on `assessed`) mapped per research B3, using real `ChatReviewResult` fixtures produced by the lifecycle in T157 as well as table rows.
- [x] T160 [P] [US4] Extend `backend/tests/unit/connectors/connectorChatPort.test.ts`: `respond` maps `ChatReviewResult` to `draft`, `no_draft` and `human_owned`.
- [x] T161 [P] [US4] Write `backend/tests/contract/connectors/connector-chat-port.contract.test.ts`: `answer` unchanged for Slack and WhatsApp; `ingest` and `respond` shapes.

### Tests first: held replies

- [x] T162 [P] [US4] Write `backend/tests/unit/handoff/held-reply-state.test.ts` covering every row of the data-model held-reply machine.
- [x] T163 [P] [US4] Write `backend/tests/unit/handoff/held-reply-service.test.ts` with a fake `HeldReplyChannelScope`:
  - `hold` is idempotent on `reviewRef`, and is born `superseded` when the bound policy or ownership is stale or the answer is not the latest message;
  - release: unchanged → agent message from the draft presentation; edited → operator message, original retained;
  - ownership is unchanged on release;
  - the policy lock is compared;
  - refusals: `not_pending`, `ownership_changed`, `policy_changed`, `channel_not_ready`;
  - discard keeps attention open;
  - list `open` excludes `queued_auto`;
  - `current` returns `{ heldReply }`.
- [ ] T164 [P] [US4] Extend `backend/tests/unit/handoff/conversation-ownership-service.test.ts`: takeover, transfer to self and reply supersede a `pending` or `queued_auto` draft through the `heldReplies` scope inside the same unit of work, and clear discarded attention.
- [ ] T165 [P] [US4] Write `backend/tests/unit/app-composition/held-reply-unit-of-work.test.ts`: lock order (conversation → ownership → channel scope → conditional held-reply update → message → enqueue); the channel scope resolved by `policyRef` prefix; drain push after commit only.
- [ ] T166 [P] [US4] Write `backend/tests/unit/app-composition/mailbox-policy-change.test.ts`: mailbox `FOR UPDATE`, version bump, history row and `supersedePendingForPolicy` in one transaction.
- [ ] T167 [US4] Write `backend/tests/integration/held-reply-visibility.integration.test.ts` (research B9 surface list). Held text in `pending`, `discarded` and `superseded` never appears in:
  - `listByConversationId`, `listRecentByConversationId`, `countByConversationId`, `listWindowByConversationId`, `listSinceByConversationId`;
  - `chatHistoryService` history and detail and the history API;
  - published `message.created` events;
  - the next review's history window;
  - conversation summaries;
  - Ray `conversation_transcript`.

  `queued_auto` rows are added in T228.
- [ ] T168 [US4] Write `backend/tests/integration/held-reply-release.integration.test.ts`:
  - concurrent releases → one message and one `email.send`;
  - the loser gets `409` with the current state;
  - ownership unchanged;
  - a policy change racing a release → exactly one wins (`policy_changed` or sent);
  - SC-004: zero `email.send` rows for pending drafts.

### Tests first: email draft pipeline

- [ ] T169 [P] [US4] Write `backend/tests/unit/email-channel/publication-decision.test.ts` for the ports §6e order: authority → `sending_not_verified` → `draft_mode` → `send_budget` → outcome; fail-closed on unknown facts; hold when there are suppressed effects.
- [ ] T170 [P] [US4] Write `backend/tests/unit/email-channel/review-runner.test.ts`:
  - claims a due link with a lease and reads revision R;
  - skips the model when `review_ref` R exists;
  - supersedes the previous pending draft;
  - `respond(review)` with the window;
  - `draft` → `hold` with the bound policy and ownership;
  - `no_draft` → `requestHumanOwnership` with the engine reason or `review_unavailable`;
  - completion `WHERE review_revision = R`;
  - retry schedules a drain at the backoff time;
  - terminal failure → `review_unavailable`.
- [ ] T171 [P] [US4] Extend `backend/tests/unit/email-channel/inbound-processor.test.ts`: `run_review_turn` increments `review_revision`, sets `review_due_at` via COALESCE and `review_policy_version`, and schedules a drain at `review_due_at`; ingest supersedes a pending draft (`newer_inbound`).
- [ ] T172 [P] [US4] Extend `backend/tests/unit/email-channel/mailbox-service.test.ts`: `supportedModes` includes `draft`; the default becomes `draft`; existing mailboxes are not upgraded; a downgrade supersedes drafts.
- [ ] T173 [P] [US4] Extend `backend/tests/unit/email-channel/email-send-action-handler.test.ts` for `held_release`: an agent author gets `Auto-Submitted: auto-generated`; an edited release is operator-authored with no header; renewal at materialization (gated by T008).
- [ ] T174 [P] [US4] Write `backend/tests/contract/held-replies.contract.test.ts` for the openapi-additions §2 held-reply routes: `sessionOnly` takeover permission, error codes, the `{ heldReply }` root, audit `hitl.held_reply`.
- [ ] T175 [P] [US4] Create `backend/tests/fixtures/conversation-quality/emailOutcomeTable.ts` (structural, `operator_only` and `draft` rows) and `backend/tests/unit/eval-suite/email-outcome-table.test.ts`, driving the runner with a stub `respond`. For each row assert the decision, held-reply presence, no intent or `email.send` for non-publish rows, the attention kind, and history exclusion.
- [ ] T176 [P] [US4] Extend `backend/tests/unit/operatorCopilot/email-channel-tools.test.ts` (the `held_replies` tool, object root) and `copilot-needs-attention.test.ts` (held replies merged into `approval` with `heldReplyId`; routine decisions unaffected).
- [ ] T177 [US4] Write `backend/tests/integration/email-review-revision.integration.test.ts`:
  - a stale worker holding revision R while a new inbound makes R+1: R's draft is `superseded`, R+1's due time is not cleared, and one current draft remains;
  - a crash between hold and completion: re-claim finds `review_ref` and runs no second turn.

### Implementation: review mode

- [x] T178 [US4] Add `review` to `backend/src/shared/domain/turnExecutionMode.ts`, covering both the capabilities and the `resolveSkillEffectPolicy` arm (after T156, T020).
- [x] T179 [US4] Implement review in chat (after T157, T158, T178, T022):
  - create `backend/src/modules/chat/types/chatReview.ts` and `backend/src/modules/chat/services/reviewDraft.ts`;
  - add `ChatService.review()` to `chatService.ts` (guards at `:896-911` and `:913-942`);
  - add the existing-message branch in `chatSessionPreparer.ts`;
  - add the `draft` arm to `CompletedAssistantTurn` in `chatTurnLifecycle.ts`;
  - wire the R2 collector into the result and add `agent_skill_effect_suppressed_total{mode,site}`.

  `chatResponses.ts` is not modified.
- [x] T180 [US4] Add `ConnectorTurnFacts`, `ConnectorTurnResult`, `ConnectorReplyDraft`, `ConnectorRespondInput` and `respond` to `packages/connector-api/connectorPlugin.d.ts`. Create `backend/src/modules/connectors/services/connectorTurnFacts.ts` and implement `respond` in `connectorChatPort.ts` (after T159–T161, T179).

### Implementation: held replies

- [x] T181 [US4] Implement `backend/src/modules/handoff/heldReplies/heldReplyState.ts` (after T162).
- [x] T182 [US4] Implement `backend/src/db/repositories/heldReplyRepository.ts`, including the supersede scope methods (after T155).
- [x] T183 [US4] Implement `backend/src/modules/handoff/heldReplies/heldReplyService.ts` (the `hold`, `findByReviewRef` and operator ports) and the exports in `handoff/public.ts` (after T163, T181, T182).
- [ ] T184 [US4] Add `heldReplies: HeldReplySupersedeScope` to `OwnershipChangeUnitOfWork` and `OwnershipReplyUnitOfWork` (`conversationOwnershipService.ts:50-72`), add the supersede calls in `takeOver`, `transfer` and `reply`, and bind `HeldReplyRepository(trx)` in `backend/src/app/composition/conversationOwnershipReplies.ts` and the change unit of work (after T164, T182).
- [ ] T185 [US4] Create `backend/src/app/composition/heldReplyUnitOfWork.ts` with the channel-scope registry keyed by `policyRef` prefix (after T165, T183).
- [ ] T186 [US4] Complete `backend/src/app/composition/mailboxPolicyChange.ts` (add supersede), and create `backend/src/modules/emailChannel/heldReplyChannelScope.ts` with `lockPolicy`, registered under `email_mailbox:` (after T166, T185).
- [ ] T187 [US4] Add the held-reply supersede scope to `backend/src/app/composition/conversationIngest.ts`, and call it from `conversationIngestService.ts` on a new message for an existing conversation (`newer_inbound`).

### Implementation: email draft pipeline

- [ ] T188 [US4] Implement `backend/src/modules/connectors/plugins/email/emailPublicationDecision.ts` (after T169).
- [ ] T189 [US4] Implement `backend/src/modules/connectors/plugins/email/emailReviewRunner.ts` and stage 2 in `emailChannelWorker.ts`, with scheduled review drains (after T170, T177, T180, T183, T188).
- [ ] T190 [US4] Add review scheduling (revision, due time, policy version, drain) to `emailInboundProcessor.ts` (after T171, T189).
- [ ] T191 [US4] Composition: add `draft` to `supportedModes` and make it the default; wire the review runner and held-reply ports; add the `held_release` trigger to the `email.send` handler (after T172, T173, T186, T189; gated by T008).

### HTTP, governance, Ray

- [ ] T192 [US4] HTTP (after T174, T183):
  - create `backend/src/app/http/routes/heldReplyRoutes.ts` and `openapi/paths/heldReplyPaths.ts`;
  - add `sessionOnly` rows in `apiPrincipalRoutePolicy.ts` and `listHeldReplies` / `getCurrentHeldReply` in `operationPermissionRequirements.ts`;
  - run `generate:openapi`, the SDK `sync` and the MCP `sync:openapi`.
- [ ] T193 [US4] Ray (after T176, T192):
  - the `held_replies` tool in `tools/emailChannel.ts`;
  - provenance and MCP disposition entries;
  - `readApprovalQueue` (`needsAttention.ts:229-255`) merges held replies under the `approvals` source;
  - coverage: list and current → `held_replies`; `releaseHeldReply` → `neverListExclusion("unattended_live_customer_reply")`; `discardHeldReply` → `permanent`;
  - the parity tests.

### Frontend

- [ ] T194 [P] [US4] Extend `frontend/tests/unit/needs-attention.test.ts` and `needs-attention-query-state.test.tsx`: held replies render as `approval` with `heldReplyId`, and routine approvals are unchanged.
- [ ] T195 [US4] Add held replies to `frontend/lib/api-reply-review.ts`, `needs-attention-reply-review.ts` and the `needs-attention-query-state.ts` source (after T192, T194).
- [ ] T196 [US4] Write the Playwright journey `frontend/tests/e2e/email-draft-review.spec.ts` first:
  - a draft mailbox and an inbound give an `approval` item;
  - the panel shows the outcome label, the reasoning trace and the suppressed-action badge;
  - send; edit and send; discard keeps the item until a reply;
  - a newer inbound replaces the draft;
  - a second operator sees "already released";
  - focus kept and status announced.
- [ ] T197 [US4] Create `frontend/components/dashboard/inbox/held-reply-panel.tsx`, mount it from `inbox-response-view.tsx`, and offer `draft` in the card from `supportedModes` (after T195, T196).

### Evals, docs, verification

- [ ] T198 [P] [US4] Extend `backend/tests/unit/eval-suite/suite-core.test.ts` first, then support an optional case `executionMode: "review"` in the suite runner (`backend/src/modules/eval/suite/`). Add two `email`-tagged cases to `backend/tests/fixtures/conversation-quality/cases.ts` asserting `turn_grounding_verdict`, `turn_answer_coverage` and no persisted assistant row. The baseline is re-recorded in the nightly run only.
- [ ] T199 [P] [US4] Docs:
  - `docs/email-channel.md`: draft mode, held replies, labels, supersede rules, revision and coalescing;
  - `docs/human-takeover.md`: held replies in the approval lens; release does not take ownership;
  - `docs/architecture/assistant-turn-spine.md`: the review mode and the draft completion;
  - `docs/architecture/code-map.md`;
  - the portal mdx, then a corpus resync.
- [ ] T200 [US4] Backend: suites, lint, depcruise, dead code, build. `chat-turn-lifecycle.test.ts` must still pass unchanged.
- [ ] T201 [US4] Frontend unit and `test:e2e -- email-draft-review`; quickstart §5 deterministic rows; `pnpm run ci:local -- origin/main`.

**Checkpoint**: `draft` works end to end. Ship it together with S4.

---

## Phase 7: S4 Every automatic behavior is bounded (User Story 5)

**Goal**: generation budget per revision, coalescing, the policy-at-acceptance cap, and automated-mail gating, proven under flood.

- [ ] T202 [P] [US5] Write `backend/tests/integration/email-channel-budgets.integration.test.ts`: 20 concurrent reservations never exceed the budget; the window rolls (injected clock); one charge per `(conversation, revision)` across retries.
- [ ] T203 [P] [US5] Extend `backend/tests/unit/email-channel/review-runner.test.ts`: a reservation failure applies the `generation_budget` hand-off and increments `email_budget_hits_total{budget="mailbox_generation"}`.
- [ ] T204 [P] [US5] Extend `backend/tests/unit/email-channel/inbound-processor.test.ts`: three inbound messages inside the window give one due time and one turn over all three (AS5.6).
- [ ] T205 [P] [US5] Write `backend/tests/integration/email-policy-acceptance.integration.test.ts`: mail accepted under `draft` and processed after an upgrade to `auto` runs as `draft`; mail accepted under `draft` and processed after a downgrade to `operator_only` runs as `operator_only` (FR-025, research B16).
- [ ] T206 [US5] Add `reserveGeneration` to `emailMailboxRepository.ts`, the reservation to `emailReviewRunner.ts`, and the exhausted check to `emailInboundProcessor.ts` (after T202–T205).
- [ ] T207 [US5] Write `backend/tests/integration/email-channel-flood.integration.test.ts` (the SC-006 generation half): 200 unique first-contact messages in a minute on a `draft` mailbox. Generations stop at the budget, the rest become human-owned `generation_budget`, and nothing is lost.
- [ ] T208 [P] [US5] Write `backend/tests/unit/email-channel/protocol-corpus.test.ts`, the SC-003 CI gate over every `protocol/` fixture and adapter verdict through the processor with fakes: no turn, and visible in the event log.
- [ ] T209 [US5] Extend `backend/tests/integration/held-reply-release.integration.test.ts` (AS5.7): every agent-authored release carries `Auto-Submitted: auto-generated` in the driver request.
- [ ] T210 [P] [US5] Docs: budgets, coalescing, automated-mail handling (RFC 3834 signal list), and policy-at-acceptance in `docs/email-channel.md` and the portal mdx; corpus resync.
- [ ] T211 [US5] Verification: suites, the flood test, metrics emitted, `pnpm run ci:local -- origin/main`.

---

## Phase 8: S5 Ray and docs completion (FR-047, FR-044)

- [ ] T212 [P] Add Ray deterministic rows to `backend/tests/fixtures/copilot-evals/cases.ts`:
  - mailbox configuration, the event-log summary and held replies → the expected read tools;
  - "send this held reply" → refusal with the never-list reason;
  - "switch the mailbox to auto" → the deferred-exclusion explanation.
- [ ] T213 Run `backend/tests/unit/operatorCopilot/copilot-eval-suite.test.ts`. Re-record `backend/tests/fixtures/copilot-evals/baseline.json` with `pnpm run evals:copilot:update-baseline` only for intended changes (live, on demand).
- [ ] T214 [P] Update `docs-portal/content/operators/copilot.mdx`: Ray's email read tools and its excluded mutations.
- [ ] T215 [P] Confirm `operator-mcp-doc-parity.test.ts` and `operator-mcp-catalog.test.ts` pass with the four email tools, and update the operator MCP docs they check.
- [ ] T216 [P] Final docs pass (after reading `docs/document-writer-prompt.md`): `docs/email-channel.md` complete for every mode except `auto`; `code-map.md`; `readme.md`; `human-takeover.md`.
- [ ] T217 Run `pnpm --dir packages/product-docs run sync` and `sync:check`.
- [ ] T218 Verification: `test:unit`, `test:contract`, lint, dead code.

---

## Phase 9: S6 Agent answers automatically when the publication decision allows (User Story 6, Priority: P4)

**Goal**: on an opted-in `auto` mailbox, a grounded, complete, non-hand-off result with budget room is queued as `queued_auto` and sent once it is re-authorized at dispatch. Everything else is held, and held content never becomes a message row. Gated by T008.

**Independent Test**: spec US6 "Independent Test", plus a takeover, a policy downgrade and a crash between queue and materialize.

### Tests first

- [ ] T219 [P] [US6] Extend `backend/tests/unit/email-channel/publication-decision.test.ts` with every auto row of the outcome table.
- [ ] T220 [P] [US6] Extend `backend/tests/unit/handoff/held-reply-service.test.ts` for `queueAuto` and `materializeAuto` (fake channel scope):
  - queued idempotently on `reviewRef`;
  - refused with `ownership_changed`, `policy_changed`, `send_budget` or `superseded`;
  - materialize authorized → `released` (`auto`), the message from the draft and `recordMaterialized`;
  - unauthorized → back to `pending` (`authority_changed`) with no message;
  - superseded while queued → `not_queued`.
- [ ] T221 [P] [US6] Write `backend/tests/unit/email-channel/held-reply-channel-scope.test.ts`: `reserveAutoSend` against `thread_send_budget`; `enqueueAutoSend` key `email:send:held:<id>` with a payload whose `messageId` is null; `authorizeAutoDispatch` (enabled, mode `auto` at the bound version, ownership `ai_owned` at the bound version, domain verified); `recordMaterialized` writes the intent.
- [ ] T222 [P] [US6] Extend `backend/tests/unit/email-channel/email-send-action-handler.test.ts` for `auto_reply`:
  - `materializeAuto` is called first;
  - `not_queued` and `returned_to_pending` → no send;
  - after materialization, an unknown outcome followed by revoked authority → `uncertain` (not halted, never re-queued as a draft).
- [ ] T223 [P] [US6] Extend `backend/tests/unit/email-channel/review-runner.test.ts`: `publish` → `queueAuto`; refusals → hold with the mapped reason.
- [ ] T224 [P] [US6] Extend `backend/tests/unit/email-channel/mailbox-service.test.ts`: `supportedModes` includes `auto`; switching to `auto` requires an explicit opt-in flag in the request.
- [ ] T225 [P] [US6] Add the auto rows to `backend/tests/fixtures/conversation-quality/emailOutcomeTable.ts` and `email-outcome-table.test.ts` (SC-005).
- [ ] T226 [US6] Write `backend/tests/integration/email-auto-reply.integration.test.ts`:
  - publish → materialize → one send with `Auto-Submitted`;
  - a takeover between queue and materialize → no message, `superseded`;
  - a downgrade → back to `pending`, no message;
  - a headerless responder stops at the thread budget with one `approval` flag (the SC-006 thread half);
  - a human-owned conversation runs no turn (AS6.3).
- [ ] T227 [US6] Extend `backend/tests/integration/email-channel-crash-recovery.integration.test.ts` with crashes after `queueAuto` before the drain, inside materialize, and after provider accept: at most one message and one accept.
- [ ] T228 [US6] Extend `backend/tests/integration/held-reply-visibility.integration.test.ts`: `queued_auto` and returned-to-`pending` content is invisible on every listed surface.

### Implementation

- [ ] T229 [US6] Add `queueAuto`, `materializeAuto` and the `HeldReplyDispatchPort` to `heldReplyService.ts`, and the queue and materialize transactions to `heldReplyUnitOfWork.ts` (after T220).
- [ ] T230 [US6] Add `reserveAutoSend`, `enqueueAutoSend`, `authorizeAutoDispatch` and `recordMaterialized` to `backend/src/modules/emailChannel/heldReplyChannelScope.ts` (after T221, T229).
- [ ] T231 [US6] Add the `auto_reply` trigger to `emailSendActionHandler.ts` (after T222, T230).
- [ ] T232 [US6] Add the publish path to `emailReviewRunner.ts` (after T223, T229).
- [ ] T233 [US6] Composition: add `auto` to `supportedModes`. Add a sweep step that returns stale `queued_auto` rows to `pending` when `auto` is unsupported, which is the rollback path in plan.md (after T224, T229–T232).

### Frontend, docs, verification

- [ ] T234 [US6] Extend `frontend/tests/e2e/email-channel-setup.spec.ts` first: enabling `auto` needs a confirmation that shows the send budget.
- [ ] T235 [US6] Offer `auto` in `email-channel-card.tsx` with a confirmation dialog and the budget display (after T234).
- [ ] T236 [P] [US6] Docs: auto mode, publication rules, the queued-auto lifecycle, budget renewal and rollout gates in `docs/email-channel.md` and the portal mdx; corpus resync.
- [ ] T237 [US6] Verification: suites, lint, dead code, build, e2e. Record the message-queue review in the PR (`auto_reply` trigger, `held:` key, no new queue). Run `pnpm run ci:local -- origin/main`.

---

## Phase 10: Rollout (plan.md "Rollout and Rollback")

- [ ] T238 Apply Terraform per region (staging, then live and live-eu) **before** the image that needs it, and confirm the `email_channel` queue and the sweep job exist.
- [ ] T239 Register the relay domain with receiving in each region's provider account, point the webhook at `/api/connectors/email/webhook`, and store the secrets in Secret Manager. Rehearse signing-key rotation with `EMAIL_CHANNEL_WEBHOOK_SECRET_PREVIOUS`.
- [ ] T240 Before deploying migration 214: count `conversation_activity` rows per region, and above 100k pre-create `conversation_activity_workspace_closed_v2_idx` `CONCURRENTLY` (runbook in `docs/email-channel.md#operations`).
- [ ] T241 Deploy with `EMAIL_CHANNEL_PROVIDER` set and workers disabled. Smoke on staging: a signed webhook gives 200 and one row. Then enable workers on staging.
- [ ] T242 Provision the contracts/events.md alerts in `infra/terraform/monitoring.tf`, after confirming the metrics export path. If the counters are not exported, use log-based metrics on the failure log lines.
- [ ] T243 Run the `operator_only` pilot: one forwarded mailbox, one workspace, US region first, one week watching the backlog, stuck-event and auth alerts.
- [ ] T244 Enable operator sending on the pilot once its domain verifies (S2 deployed, and migration 217 applied after the S1 query switch is live everywhere).
- [ ] T245 Enable `draft` for the pilot once SC-004, the outcome table, the visibility suite, the journeys and the SC-006 flood in staging all pass, and T008 is go.
- [ ] T246 EU rollout, only after T012 is go or a written residency decision exists.
- [ ] T247 Enable `auto` only after reviewed drafts, every non-publish outcome-table row green, and explicit owner opt-in. Rehearse rollback: workers off, webhooks still persisting, no `uncertain` replay, stale `queued_auto` rows returned to `pending`.

---

## Follow-ups found while implementing S1 (2026-10-03)

Not fixed in S1; each needs a small decision before it is tasked.

1. **Same Message-Id through two provider events** (research B15 gap): the same inbound message delivered to one mailbox by two different provider events (for example two forwarding rules) opens a second conversation. Decide whether the thread index dedupes on `(mailbox, inbound Message-Id)` and attaches, or records a `channel_exception`.
2. **Retry after relay-token rotation grace**: a failed delivery retried after its mailbox's previous token left the grace period cannot resolve a mailbox and cannot be retried again. Decide whether retries resolve by the mailbox id stored on the delivery instead of the address.
3. **Frontend channel list is copied in five files** (`agent-channel-catalog.ts`, `dashboard-areas.ts`, `area-subnavs.tsx`, `agent-view.tsx`, `api-types.ts`): a missing shared port. Extract one catalog the others derive from before the next channel.
4. **Unconfigured overview shape**: `getEmailChannel` returns `configured: false`, `supportedModes: []`, `defaultMode: null`; `openapi-additions.md` now says so. Other settings routes return 503 and the facts route 404 when the channel is unconfigured.
5. **`email_backlog` gauge** from `contracts/events.md` is not emitted yet; the sweep has the counts.
6. **Playwright journey stubs the API in the browser**, matching the existing e2e setup; it does not drive the local provider or `email:dev`. The end-to-end path is covered by the backend integration suites instead.
7. **Forwarded-mail fixtures** (Google Workspace, Microsoft 365) are still `it.todo` in the Resend receiver test and the thread-protocol suite; they need the tenant checks from S0 (T007, T009, T010).

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies.
- **S0 (Phase 2)**: needs only Setup. Its gate T014 blocks adapter merges, and its go/no-go can stop S1 (T007) or agent sending (T008).
- **R3** blocks T088. **R1 and R2** block Phase 6 and can run in parallel with Phases 4–5.
- **S1 (Phase 4)**: after Setup and R3. T054, T055 and T067/T068 wait on S0 answers.
- **S2 (Phase 5)**: after S1. Migration 217 ships after S1's query switch is live in every region.
- **S3 (Phase 6)**: after S2 (release needs `email.send`), R1 and R2.
- **S4 (Phase 7)**: after S3, and ships with it.
- **S5 (Phase 8)**: after S3.
- **S6 (Phase 9)**: after S4, and gated by T008.
- **Rollout (Phase 10)**: steps track the slices (T243 after S1, T244 after S2, T245 after S3+S4, T247 after S6).

### Critical path

T001–T003 → T007/T008/T014 (S0 go) → T015–T016 (R3) → T024–T029 (schema) → T052 → T056–T059 (adapters) → T079–T083 (repositories, services, ingest, processor) → T088 (composition) → T090–T091 (contract) → T106 (S1 verified) → T110–T113, T133–T142 (send path) → T151 → T018–T022 (R1/R2, in parallel earlier) → T154–T155, T178–T180 (review mode) → T181–T187 (held replies and scopes) → T188–T191 (pipeline) → T200 → T202–T207 (bounds) → T219–T233 (auto) → T247.

### Within each slice

- Backend tests are written and seen failing before their implementation tasks.
- Playwright first for visible behaviour. Frontend unit tests only for logic.
- Migrations and snapshots precede repositories. Ports precede adapters. Adapters precede orchestration. Composition comes last.
- Governance registries (principal policy, permission requirements, provenance, MCP disposition, coverage) land with the route or tool that needs them, in the same slice.

## Parallel Example: S1 pure layer

```bash
# Launch the S1 pure-function tests together:
Task: "T030 relay-tokens.test.ts"      Task: "T032 mailbox-routing.test.ts"
Task: "T034 inbound-classification.test.ts"  Task: "T035 thread-resolution.test.ts"
Task: "T036 engagement-disposition.test.ts"  Task: "T037 quoted-history.test.ts"
# Then their implementations (T042–T051), each in its own file.
```

## Implementation Strategy

### MVP first

Setup → S0 go → R3 → S1. Stop and validate the `operator_only` pilot (T243). This makes the Inbox a durable mirror of the mailbox with zero agent risk.

### Incremental delivery

S1 → S2 (operators reply) → R1/R2 + S3 + S4 (agent drafts, bounded) → S5 (Ray and docs) → S6 (auto). Each step is a deploy gate for the next (plan.md Rollout).

## Tasking notes (deviations from the plan text found while tasking)

1. **Mode gating per slice** (plan, Questions settled, item 4): the composed `supportedModes` drives the default mode and the 409 refusal. Tasks T062, T075, T172, T191, T224 and T233.
2. **S1 reply refusal**: the email deliverer is registered in S1 and refuses with `email_sending_not_available`, so an operator reply on an email conversation is never silently undelivered before S2 (T087, replaced in T141).
3. **Ray tools land with their endpoints**, because the catalog-coverage, provenance and MCP-disposition bijections fail otherwise. S5 is reduced to evals and docs.
4. **The conversation email facts endpoint and Inbox header ship in S1** (research B13), because operator-only conversations are visible from S1.
5. **`CLOSING_ACTIVITY_KINDS` feeds an OpenAPI enum** (`assistantHistorySchemas.ts`), so the S1 contract regeneration (T090) includes the new closing kinds.
6. **R2 keeps the persisted reason `suppressed_for_safe_test` and the old metric name**, because traces and `frontend/components/dashboard/spine-stage-detail.tsx:1092` read them. The mode-labelled counter arrives in S3 (T179).

## Notes

- `[P]` tasks touch different files and have no incomplete dependencies.
- Commit after each task or logical group. Stop at any checkpoint to validate the slice independently.
- Never hand-edit `backend/openapi.{json,yaml}`, `schema.ts`, `schema.sql`, the SDK snapshot or the MCP generated types.
- Never add `if (sourceChannel === "email")` to the chat, engine or operator-reply code. Channel behaviour enters only through registration and the transaction-bound scopes in research B1.
