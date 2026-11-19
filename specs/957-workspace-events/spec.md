# Feature Specification: Workspace event log and push subscriptions

**Branch**: `feat/workspace-event-log` (PR 1)
**Created**: 2026-11-19
**Status**: Approved with changes (orchestrator review, 2026-11-19); see "Review outcome" below
**Issues**: #1851 (event log + cursor API), #1852 (subscriptions + push delivery + Settings list), epic #1849
**Input**: Automations need to hear that something happened in a workspace. Record business events durably, list them by a complete cursor, and push them to subscribed URLs.

## Decisions at a glance

| # | Decision | Section |
|---|----------|---------|
| D1 | New module `modules/workspaceEventLog/`; the event contract and the recorder port live in `shared/domain/workspaceEventLog.ts`, because two emitters sit in `db/repositories` | 1, 3 |
| D2 | Transactional outbox: the event row is written in the business transaction, and a failed write fails the business action | 4 |
| D3 | The cursor is `(tx_id xid8, position)`, and a read stops at the snapshot horizon `pg_snapshot_xmin(pg_current_snapshot())` | 6 |
| D4 | Conversation fields (agent, channel, caller kind, visitor) and the operator-test filter come from one `INSERT … SELECT FROM conversations` in the recorder, not from the emitters | 2, 5 |
| D5 | Handoffs are bridged from the `handoff_requested` conversation activity, so there is one emit point for every current and future handoff path | 2 |
| D6 | `routine.completed` is derived where the routine-state transition is captured, so the baselined `chatService.ts` is not touched | 2 |
| D7 | Erasure goes through cascading foreign keys. Consent withdrawal gets a `MessageCopyWithholder`. Retention is a 30-day `ConversationDataRetentionRule` | 8 |
| D8 | Delivery runs one ordered drain job per subscription on the existing background-job substrate. Retry state lives on the subscription row. No AMQP and no new queue | 10 |
| D9 | Subscriptions are separate from webhook destinations. They share the signer, URL guard and secret encryption | 10, 11 |
| D10 | Each push re-checks the creating credential, so revoking a token stops its subscriptions | 7, 10 |

## Review outcome

### Fix round 1 (final), as built

- **Notify steps (H1).** The routine skill dispatcher passes `sensitiveInputKeys`: the inputs a typed binding fills from a sensitive slot. `NotifyExecutor` hands the outbox a `maskedPayload` for the event and still delivers the payload whole.
- **Naming (H2, L8).** The SSE contract suite is restored to main's `workspace-events.contract.test.ts`. New files use "event log" (`workspaceEventLog*`, `workspace-event-log.*`).
- **Horizon (M1).** The five-minute idle-in-transaction timeout and the span lag are in (see the horizon section). The approvals restructure is the next small PR.
- **Withholding by structure (M2).** See §8.
- **Tests (M3, M4).** They separate xid order from position order, page one transaction's events across a page boundary, move a narrow filter's cursor to the horizon, and record through `claimInTransaction` and `getOrCreateByAnonymousSession`. Every served event is parsed against its schema. The contract suite covers the takeover deny case and a 410 on an aged cursor.
- **One seam (M5).** `app/composition/workspaceEventLog.ts` owns `workspaceEventRecorder` and `withWorkspaceEvents(activity)`. Every construction gets them injected, `PostgresSlackPersistence` included (through `SlackPlugin` and `buildSlackInboundJobComposition`).
- **Descriptions (M6, M7, L4).**
  - `decision.pending` is described as a notification tokens cannot act on.
  - `contactRequestId` is the queued request's stable id, with a pointer to `GET /api/v1/history/chat/{conversationId}`.
  - `agentId` and `visitorId` are copies taken when the event was recorded.
  - `handoff.requested.reason` is an enum from `CONVERSATION_OWNERSHIP_REASONS` (`shared/domain/conversationOwnershipReasons.ts`, which `ConversationOwnershipReason` now derives from).
  - Each type's `version` is published as a literal.
- **Cursors (L1, L3).** A full page's cursor ages from its last event's `occurredAt`; a cursor at the horizon ages from the read. Out-of-range `tx`/`pos` answers 400.
- **Turn-path contact values (L2)** carry only the routine's declared slots. The save transition carries `declaredSlotKeys` from the turn's routines.
- **Cleanup (L5, L7, L9, L10).**
  - The DSAR reason is reworded.
  - The store port (`LogPosition`, `StoredLogEvent`, `WorkspaceEventLogStore`) lives in the shared contract.
  - The leftover fakes are removed.
  - `workspace_events_cursor_expired_total` is counted.
  - A shared-Postgres test helper waits for the horizon to pass the file's writes.

### Phase 2 review

D1–D10 are accepted. The orchestrator's answers and changes, as built:

- **`conversation.started` stays in `ConversationRepository`, with the recorder required.** The constructor takes `(db, events)`. The read-only constructions (15 in production) use `ConversationRepository.forExistingConversations(db)`. It returns the repository typed without its three start methods, and is backed by a recorder that refuses. The three constructions that start conversations pass the composition seam's `workspaceEventRecorder`. `createWithInitialAssistantMessage` had no caller and is removed.
- **When a conversation row is created** (verified in code):
  - Opening the widget or fetching its greeting creates no row. `ChatBootstrapService.startConversation` (`chat/services/chatBootstrapService.ts:97`) reads and writes only the greeting cache and holds no conversation repository.
  - The web, embed, public link and agent API row is created in `ChatSessionPreparer.prepare` (`chatSessionPreparer.ts:460`). That is the same call that stores the caller's message (`:529`), and it runs only for a chat turn.
  - MCP and A2A rows are created in `askAgent` (`agentConverseService.ts:109`), a caller turn.
  - Slack rows are created on an inbound message (`slackPersistence.ts:203`). Email and ingested rows are created with the ingested message (`conversationIngestService.ts:95`).
  - The rule: **`conversation.started` fires when the first message a person or calling agent sends creates the conversation.**
- **`decision.pending.reason` is kept.** It is the authored step metadata, read from the un-rendered step (`packages/conversation-engine/src/routineRunner.ts:1016`) and copied by `buildPendingDecisionTransition` (`modules/approvals/decisionProposal.ts:72`). It is never rendered with the run's values, so it carries no slot value to mask.
- **PR order:** PR 1 (log, API, conversation events), then PR 3 (subscriptions, delivery, Settings), then PR 2 (document events). PR 1's contract and OpenAPI declare only the five conversation types. The document types and their docs ship with PR 2, and PR 2 closes #1851.
- **Defaults** (cap 25, 30 days, disable after 24 h), the shared queue, the 60 s sweep and the DSAR exclusion are accepted. `source.synced` is cut. `decision.pending` stays a notification: the resolve route is session-only.

Changes made while building PR 1:

- **`contact_request.created` data is `{ contactRequestId, values }`.** `routineId` and `sensitiveSlotKeys` are dropped. A queued `contact.send` payload carries neither, and which keys are sensitive must never be inferred from a value's text. The engine already masks the values (`outboundVariables`).
- **`routine.completed`'s idempotency key is the run plus a digest of its masked values.** A retried turn records nothing new. A visitor's correction to an ended run (a completed-routine slot correction re-saves the completed state) records the run again with the corrected values and the same `executionId`.
- **The ended run is captured where the routine-state transition is captured** (`DeferredRoutineStore.save`, `approvalResumeTransition`), as an `ending` on the `save` transition. The values come from the routines module's `endedRunValues`, which uses the engine's own `declaredSlotVariables`.
- **Consent withdrawal removes the conversation's events whose values state a withdrawn value**, as the audit withholder removes its copies, rather than rewriting them.
- **Every production activity recorder goes through the handoff bridge**, including the email send handler's own recorder.
- **`createConversationActivityComposition` takes `{ repositories, teammateLabels }`** and wires the Postgres recorder into the bridge itself. This keeps the baselined `dependencies.ts` from growing (1451 → 1449).
- **The turn persistence's outbox writes moved to `modules/chat/infra/turnOutboxWrites.ts`**, which also records the turn's events. The persistence went from 657 to 593 lines.

## Horizon stall analysis (PR 1)

A read returns only rows whose transaction is older than every transaction still running in the cluster. A write transaction that stays open therefore holds back every workspace's newer events until it ends. Read-only transactions hold no xid and do not count.

| Writer | Bound |
|---|---|
| Every app statement | `statement_timeout` = `DB_STATEMENT_TIMEOUT_MS` (15 s default) on the pool (`shared/infra/database.ts:88`, `app/server/builders/infra.ts:99`), plus a 20 s client-side `query_timeout`. |
| Chat turn persistence, activity, ownership, email units of work, consent withdrawal, erasure | Short sequences of DB statements, with no network call inside the transaction in the units read. Bounded by their statement count × 15 s; in practice milliseconds. |
| Chunk and vector publish (`chunkRepository.publishForDocumentRevision`), vector index work, embedding backfill batches | One document revision or one bounded batch per transaction, each statement ≤ 15 s. |
| Conversation erasure and DSAR erasure | At most 200 conversations per request (DSAR pages), each statement ≤ 15 s. |
| Retention sweep | Bounded batches, one transaction each. |
| Workspace or organization deletion (`personalCredentialLifecycleRepository.deleteWorkspace`) | One transaction cascading a whole workspace, in a handful of statements, each ≤ 15 s. The largest bounded writer: under a minute for a statement count this size. |
| **Decision resolution** (`pendingDecisionRepository.claimInTransaction`) | Claims the decision with an advisory lock and a plain read, neither of which takes an xid, so the resumed routine turn's model calls and skill dispatches run under no xid. The xid is taken when the runner commits. From then until COMMIT the transaction runs only database statements: the conversation row lock, the decision update, its activity row, the turn's action-authorization reads, and the turn's writes. The outbox drain push and the completion analytics run after COMMIT. Milliseconds, each statement bounded by `statement_timeout`. Not a staller. |
| **Migrations at deploy** (`db/runMigrations.ts:110-111`) | `SET LOCAL statement_timeout = 0`: unbounded per migration. A long migration delays events for its duration. |
| **A transaction left open** | No `idle_in_transaction_session_timeout` is set on the pool (`database.ts:82-92`) or as a Cloud SQL flag (`infra/terraform/database.tf:60-69`, which sets only IAM and pgAudit flags). A connection idle inside an open transaction is bounded only by its process ending: a bug, or a Cloud Run instance whose CPU is throttled after its response while a detached promise holds the transaction. **Worst case unbounded.** |

Done in the review round:

- Every pool sets `idle_in_transaction_session_timeout` to five minutes (`shared/infra/database.ts`, no env var), which bounds the "transaction left open" case.
- The longest legitimate idle-in-transaction wait is decision resolution: its resumed turn calls the model inside the decision's transaction, and the OpenAI client has no explicit timeout (the SDK default is 600 s with 2 retries). A resolution that waits past five minutes fails, and the decision stays pending to be resolved again.
- Migrations run their statements actively (`statement_timeout = 0`, never idle), so the timeout does not touch them.
- The `workspace_events.list` span carries `workspace_events.horizon_xid_lag` (`pg_snapshot_xmax − pg_snapshot_xmin` from the read's own snapshot).
- PR 3's `workspace_event_delivery_lag_ms` (now − `occurredAt` at delivery) shows a stall as a rising lag across every subscription at once.

Follow-up PR, before PR 3: `fix(approvals): resolve a decision without holding back the event log`. It claims the decision with `pg_advisory_xact_lock(hashtextextended('pending-decision:' || handle, 0))` plus a plain `status = 'pending'` read, so no xid is taken while the routine resumes. The resume runner reaches the transaction only through the port's `commit(work)`. It calls that after its model and skill work. `commit` locks the conversation row, writes the `pending_decisions` UPDATE and the `approval_decided` activity insert, then runs `work`, which is `completeAssistantTurn`, in the same transaction. The horizon stays global.

## 1. Placement

`backend/src/modules/workspaceEventLog/` is a new module.

**It knows:**
- the v1 event types, the envelope, and the schema version of each type;
- which permission reads which type;
- storage, the cursor, and the snapshot horizon;
- retention, and withholding values on consent withdrawal;
- subscriptions, delivery, signing, retry/disable policy, and the owner re-check.

**It must not know:**
- chat turns, routine graphs or slots, contact routines, decision gates, conversation ownership, or document processing;
- which code path produced an event.

It gets the facts it stores as typed drafts. Two exceptions:
- It reads the conversation fields every conversation event carries from the `conversations` row, in the same statement as the insert (D4).
- It reads `title`, `source_kind` and `source_id` from the `documents` row.

These are row columns named by the event contract, not owner internals.

**`backend/src/shared/domain/workspaceEventLog.ts` (new) holds the published contract:**
- `WORKSPACE_EVENT_TYPES`;
- the per-type `data` zod schemas and their inferred types (the OpenAPI registry imports the same schemas);
- `WorkspaceEventDraft`, a union of a `conversation` scope and a `document` scope;
- the `WorkspaceEventRecorder` port.

It lives in `shared/domain` because `ConversationRepository` and the document job repository emit, and a `db/repositories` adapter may not import a module (the comment on `shared/domain/conversationDataRetention.ts`).

**What emitters own.** Each one owns its pure mapper from its own facts to a draft:

| Emitter | Mapper |
|---|---|
| chat | `modules/chat/services/workspaceEventLogDrafts.ts` |
| documents | `modules/documents/services/documentWorkspaceEvents.ts` |
| conversation activity | the handoff bridge (§2) |

## 2. Ports and emit sites

```ts
// shared/domain/workspaceEventLog.ts
export interface WorkspaceEventRecorder {
  /** Writes in the caller's transaction. A failed write throws, so the change rolls back with it. */
  record(db: Db, draft: WorkspaceEventDraft): Promise<void>;
}
```

The port follows `ConversationActivityRecorder` (`modules/conversationActivity/contracts/index.ts:170-173`).

- The Postgres implementation is `db/repositories/workspaceEventLogRepository.ts`.
- `draft.idempotencyKey`, when present, makes the write `ON CONFLICT DO NOTHING` on `(workspace_id, idempotency_key)`.
- A conversation draft whose conversation is missing, is `purpose = 'operator_test'`, or is on an `OPERATOR_TEST_SOURCE_CHANNELS` channel inserts nothing. This is the same exclusion as history's default `end_user` scope (`shared/domain/conversationSource.ts:16-27`).

| Type | Emit site (file:line) | Who calls the port | Idempotency key |
|---|---|---|---|
| `conversation.started` | `db/repositories/conversationRepository.ts`: the four insert methods `getOrCreateByAnonymousSession` :317, `create` :366, `createIfAbsent` :381, and `createWithInitialAssistantMessage` (no caller; removed). They are reached from `chat/services/chatSessionPreparer.ts:460`, `chat/services/agentConverseService.ts:109`, `connectors/plugins/slack/slackPersistence.ts:203` and `chat/services/conversationIngestService.ts:95` | `ConversationRepository`, with the recorder as a required constructor argument; read-only constructions use `forExistingConversations(db)`. `create` opens a transaction when `this.db` is not one. The three constructions that create conversations pass it: `app/server/builders/infra.ts:235`, `app/composition/conversationIngest.ts:27`, and `connectors/plugins/slack/slackInboundJobComposition.ts:44` | `conversation.started:{id}` |
| `contact_request.created` | (a) the turn path: `chat/infra/postgresAssistantTurnPersistence.ts:85-110` `enqueueActions` inserts `contact.send` rows (`RETURNING id` added). (b) the notify path: `notify/notifyExecutor.ts:121` enqueues through the outbox built at `app/server/builders/chat.ts:409-415` | (a) the turn persistence, for each inserted `contact.send` row. (b) a chat-owned `ContactRequestRecordingOutbox` that runs `ActionRequestRepository(trx).enqueue` and the record in one transaction, wrapped by the existing `DrainTriggeringActionOutbox` | `contact_request.created:{actionRequestId}` |
| `handoff.requested` | Both handoff paths already record a `handoff_requested` activity in their transaction: `chat/infra/postgresAssistantTurnPersistence.ts:443` and `handoff/conversationOwnershipService.ts:318-326` (email review, ingest, mailbox policy change) | A `conversationActivity` bridge, `publishingWorkspaceEvents(recorder, events)`, exported from its `public.ts` and applied once in `app/composition/conversationActivity.ts:20`. Every `handoff_requested` record also records the event on the same `db` | none (each activity row is a distinct fact) |
| `routine.completed` | The ended run is captured at `chat/services/routines/deferredRoutineStore.ts:61-68` (live turns) and `chat/services/approvalResumeTurn.ts:110` (resume after a decision). It is written at `postgresAssistantTurnPersistence.ts:372` (`applyRoutineStateTransition`) | Both capture sites add an `ending` field to the `save` transition, as they add `asksConsentField`. The field holds the routine id, execution id, terminal kind (from the `completedRoutineState` metadata, `packages/conversation-engine/src/routineEnding.ts:26-47`) and the declared-slot values masked by the engine's `declaredSlotVariables` (`packages/conversation-engine/src/routineSlotValues.ts:88`, newly exported through `modules/routines/domain.ts` and `public.ts`). The turn persistence records it | `routine.completed:{executionId}` |
| `decision.pending` | `postgresAssistantTurnPersistence.ts:374` (`savePendingDecision`), the only production insert into `pending_decisions` | The turn persistence, from `input.pendingDecisionTransition` | `decision.pending:{handle}` |
| `document.processed` | A vectorize job's fenced completion: `documents/services/documentProcessingWorker.ts:433` (normal), :228 (startup reconcile) and :654 (`completeAlreadyPublishedJob`). These call `db/repositories/documentProcessingJobRepository.ts:839` `markCompleted` | The worker passes a draft for vectorize jobs. The completion write records it in the same transaction, only when the `status = 'processing'` fence hit, so it records exactly once. `documentProcessingJobRepository.ts` is baselined at 1063 lines, so the terminal-outcome writes move to `documentProcessingJobOutcomes.ts` first (the file shrinks) | `document.processed:{documentId}:{revision}` |
| `document.failed` | `documentProcessingWorker.ts:596` calls `documentProcessingJobRepository.ts:892` `markFailedIfDocumentMatches`, which already flips the document and the job in one transaction | The same extracted outcome writer records the event after the document update hits | `document.failed:{documentId}:{revision}` |

**Rejected emit points:**
- `modules/documents/infra/chunkRepository.ts:149-158`, where the document flips to `ready`. It runs raw `pg` inside a pgvector adapter, so the Kysely recorder cannot join that transaction. The job completion is the authoritative moment per `modules/documents/README.md`.
- A Postgres trigger on `conversations`. It hides product logic in SQL, and the repository uses triggers only for integrity guards.

**Every type has a clean emit site. None is cut.** Two caveats for review:
- `conversation.started` is emitted from a repository and needs the three constructions above. A new creating construction that forgets the recorder silently emits nothing. A unit test pins the recorder in each of the four insert methods, and the PR lists the constructions.
- `routine.completed` needs one additive engine export, `declaredSlotVariables`.

## 3. Dependency direction and wiring

```
shared/domain/workspaceEventLog.ts   (types, zod data schemas, recorder port)
   ^             ^                   ^                         ^
chat/infra   conversationActivity   documents/services   db/repositories (Conversation, DocumentJob, WorkspaceEvent)
   ^             ^                   ^                         ^
modules/workspaceEventLog (log reads, permissions, retention, subscriptions, delivery)
   ^
app/composition/workspaceEventLog.ts  -> wires everything below
```

`app/composition/workspaceEventLog.ts` (new) builds:
- the recorder (`WorkspaceEventLogRepository`);
- the bridged activity recorder;
- the log read service;
- the retention rule, appended to `app/composition/conversationRetention.ts`;
- the consent withholder, appended to `app/composition/consentWithdrawal.ts`;
- in #1852, the subscription service, the drain job handler (`backgroundJobHandlers.ts`), the periodic sweep, the owner check, and the post-commit wake.

`app/server/builders/infra.ts` constructs the recorder beside the other repositories and hands it to `ConversationRepository`, the turn persistence, and the document job repository.

The events module imports only `shared/*` and `modules/account/public.ts` (permission types). No owner imports `modules/workspaceEventLog`.

## 4. Transaction semantics

**Outbox in the business transaction (D2).** A failed write throws and rolls the business action back, as `ConversationActivityRecorder` does.

Reasons:
- After drafts are typed at compile time, the only failures left are database failures. Those fail the business transaction anyway, so "commit the action, drop the event" buys nothing.
- After-commit recording needs its own durable handoff. A detached promise is exactly what #1506 lost on deploy.
- An event without its fact, or a fact without its event, breaks "samples match live payloads" and "paging is complete".

Rules:
- **No runtime schema parse at write time.** A mapper bug must not fail turns. Mappers are pure and unit-tested; the contract test parses served events.
- **No shared row is locked.** No counter or head row, so emitting transactions never serialize on each other. Turn persistence records last, just before `commitFence` (`postgresAssistantTurnPersistence.ts:480`).
- **A deploy mid-request** rolls both back before COMMIT, or keeps both after it. Nothing is held in memory.
- **Delivery (#1852) never runs in the request.** The optional post-commit wake is best-effort, and a periodic sweep is the guarantee (§10).

## 5. Envelope, payloads, versioning

**Envelope** (list item and push body are byte-identical in shape):

```json
{ "id": "uuid", "type": "routine.completed", "version": 1, "occurredAt": "ISO-8601", "workspaceId": "uuid", "data": { } }
```

- `occurredAt` is the business transaction's `now()`.
- `id` is stable. It is the push `Idempotency-Key` and the key Zapier dedupes on.

**Conversation events** all start with `conversationId`, `agentId`, `channel` (`source_channel`), `callerKind` (`human` | `agent`) and `visitorId | null`.

| Type | Type-specific `data` |
|---|---|
| `conversation.started` | none |
| `contact_request.created` | `contactRequestId`, `values` (the `contact.send` payload as queued; the engine already masks sensitive slots, `outboundVariables`, `routineSlotValues.ts:82`) |
| `handoff.requested` | `reason` (the handoff reason code) |
| `routine.completed` | `routineId`, `executionId \| null`, `outcome` (`complete` \| `handoff` \| `action` \| `stuck` \| `consent_declined`), `values` (declared slots, sensitive ones as `[redacted]`), `sensitiveSlotKeys` |
| `decision.pending` | `decisionHandle`, `routineId`, `stepId`, `options: [{ id, label }]`, `deadline \| null`, `reason \| null` (see open question 5) |

**Document events** carry `documentId`, `revision`, `title`, `sourceKind` and `sourceId | null`. `document.failed` adds `failureCode | null`, the job's error code, never the message.

**Masked:** sensitive slot values (#1543), exactly as notices and completion exports mask them. The values come from the engine's own projection, never from host-side redaction.

**Deliberately excluded:**
- transcripts and message text;
- generated text: replies, summaries, conversation titles, notice copy;
- entry page URL, referrer, request context and geo;
- the verified customer id;
- teammate identities;
- routine variables that are not declared slots (tool outputs);
- decision content hash and decider scope;
- document content and failure messages.

Consumers fetch a transcript with `workspace.history.read`.

**Versioning:**
- Each row stores the `version` it was written with. v1 writes 1 for every type.
- An additive field keeps the version.
- A breaking change is a new version that the emitter writes beside the old one until consumers move. That mechanism is designed when it is needed; nothing in v1 depends on it.
- OpenAPI publishes `WorkspaceEvent` as a `oneOf` discriminated on `type`, one schema per type and version.

## 6. Cursor

**Mechanism (D3).**
- Columns: `position bigint GENERATED ALWAYS AS IDENTITY` and `tx_id xid8 NOT NULL DEFAULT pg_current_xact_id()`.
- A read returns rows with `(tx_id, position) > cursor AND tx_id < pg_snapshot_xmin(pg_current_snapshot())`, ordered by `(tx_id, position)`, in one statement.
- The fragment goes in `shared/infra/kysely/sqlHelpers.ts`. The index is `(workspace_id, tx_id, position)` plus `(workspace_id, type, tx_id, position)`.

**Why it never skips:**
- Every transaction with an xid below the snapshot's xmin has finished. A row is therefore returned only once nothing below it can still appear.
- Any row that becomes eligible later has `tx_id ≥` the earlier xmin, which is above every returned `tx_id`.
- Out-of-order commits are held back, not skipped.

**Cost:** a long-running write transaction anywhere on the database delays (never drops) newer events until it ends.
- Read-only transactions hold no xid and do not count.
- Decision resolution does not pin the horizon. Its transaction holds no xid while the resumed routine calls models and skills, and writes the decision and the turn only at the end (see the horizon stall analysis).
- Delivery lag is measured (§12).

**Rejected alternatives:**
- A per-workspace advisory lock or head-row counter taken until commit. It serializes every emitting transaction in a workspace and enters the conversation lock order (`app/composition/conversationLockOrder.ts`).
- A post-commit sequencer that assigns positions. It is another moving part that must survive deploys, and it adds latency.
- A time-lag window. It is unsound under long transactions.

**API semantics:**
- `after` absent: the newest `limit` events (oldest-first within the page), and `nextCursor` at the newest. This is a consumer's starting point and Zapier's samples.
- `after` present: events strictly after it, ascending.
- When a page is not full, `nextCursor` advances to the horizon `(xmin, 0)`, so a narrow filter keeps moving.
- The cursor is opaque (`shared/domain/cursorPagination.ts` encoding). It carries `tx`, `pos`, a hash of the type filter (`400 cursor_filter_mismatch` when reused with another filter), and its issue time.
- A cursor issued more than 29 days ago answers `410 cursor_expired` rather than silently skipping purged events.

## 7. Permissions

**New permissions:**
- `workspace.events.read` (list the log);
- `workspace.event_subscriptions.manage` (#1852 CRUD and Settings).

Both are added to `AccountPermission` and to the member list in `workspaceRoleAllows` (`modules/account/services/accountAccessService.ts:20-50, 170-185`). Member, admin and owner hold them, the same set that holds `workspace.history.read`.

**Per-type read permission**, owned by the events module:

| Types | Also requires | Matches |
|---|---|---|
| conversation types | `workspace.history.read` | `GET /api/v1/history/*` (`apiPrincipalRoutePolicy.ts:122-127`) |
| `decision.pending` | `workspace.history.read` + `workspace.conversation.takeover` | `GET /api/v1/decisions` (`apiPrincipalRoutePolicy.ts:360`) |
| document types | `workspace.documents.read` | the document reads |

**How the per-type permissions are enforced:**
- The list route requires `workspace.events.read`, then resolves the caller's readable types with `holdsWorkspacePermission`, as the activity scope does (`historyRoutes.ts:85`).
- Without `types`, the list serves the readable ones. An explicit unreadable type answers `403 event_type_not_permitted`.
- Subscription create checks the same per type.
- Each push re-checks the creator (D10), so the log and pushes never show more than history does.

**Route policy entries** (`apiPrincipalRoutePolicy.ts`), all `allow` (session and machine):
- `GET /api/v1/workspace/events` → `workspace.events.read`
- `GET|POST /api/v1/workspace/event-subscriptions` and `GET|DELETE /api/v1/workspace/event-subscriptions/:subscriptionId` → `workspace.event_subscriptions.manage`

## 8. Retention and erasure

**Retention:**
- 30 days, fixed. `WorkspaceEventLogRetention` implements `ConversationDataRetentionRule` (`shared/domain/conversationDataRetention.ts`) with table `workspace_events`.
- It deletes `occurred_at < now - 30d` in `SKIP LOCKED` batches, on the existing `conversation-retention` periodic task (every 15 minutes, local poll loop and Cloud Scheduler alike).
- It counts in `radioso_retention_rows_removed_total{table}` with no new code.

**Erasure (#1540):**
- `conversation_id` has a composite FK `(workspace_id, conversation_id) → conversations(workspace_id, id) ON DELETE CASCADE`, indexed. `workspace_id` cascades from `workspaces`.
- A conversation erasure, a visitor erasure (which deletes the visitor's conversations), the per-workspace retention window, and workspace or organization deletion therefore remove the events with no `ConversationDataEraser`.
- The port's own documentation names cascading keys as the default and erasers as the fallback for rows a key cannot reach. No event row is out of reach: document events carry no person.
- `conversation-erasure-coverage.integration.test.ts` passes on the cascading key.

**Consent withdrawal (#1544):** `WorkspaceEventValueWithholder` implements `MessageCopyWithholder`. It removes by structure, so it works after the routine's state (and with it the values) has expired: the conversation's `routine.completed` rows for the withdrawn routine, and its `contact_request.created` rows whose `values` name a covered slot (`?|`). It then removes any of the conversation's events whose strings contain a withdrawn value (`jsonbStringContainsAnyValueText`), as the audit withholder removes its copies. `WithheldMessages` carries `withdrawnRoutineSlots` (routine id and slot keys) for this. It is registered in `app/composition/consentWithdrawal.ts`.

**Data subject export:** `data-subject-export-coverage.integration.test.ts` gets `workspace_events: excluded(...)` with this reason: a 30-day copy of facts the export already carries (the conversation, and its routine actions as they left). See open question 3.

**In-flight deliveries:** a push already sent before an erasure cannot be recalled. A queued drain finds the row gone and sends nothing.

## 9. Endpoints

These sit under the existing `/api/v1/workspace` resource, next to `summary`, the connectors' credential test. They are disjoint from the session-only SSE `GET /api/v1/events` (`modules/realtime/infrastructure/config.ts:15`, `app/http/openapi/paths/workspaceEventsPaths.ts:37`). No route has `/:workspaceId` at two segments, so `DELETE /api/v1/workspace/:workspaceId` cannot shadow them.

**#1851:**

`GET /api/v1/workspace/events?types=a,b&after=<cursor>&limit=50` (limit 1-100) returns `200 { events: WorkspaceEvent[], nextCursor: string, hasMore: boolean }`.

| Status | Code |
|---|---|
| 400 | `invalid_cursor` / `cursor_filter_mismatch` / invalid `types` / invalid `limit` |
| 403 | `event_type_not_permitted` |
| 410 | `cursor_expired` |

**#1852** (Zapier REST hooks, n8n webhook lifecycle):

- `POST /api/v1/workspace/event-subscriptions` with `{ targetUrl, eventTypes: [...], label: "zapier" | "n8n" | "custom" }` returns `201 { subscription, signingSecret }`. The secret is shown once.
- `GET /api/v1/workspace/event-subscriptions` returns `{ subscriptions: [...] }`. The cap keeps it small, so there is no paging.
- `GET /api/v1/workspace/event-subscriptions/:subscriptionId` returns `{ subscription }`. n8n uses it for `checkExists`.
- `DELETE /api/v1/workspace/event-subscriptions/:subscriptionId` returns `204`.

The `subscription` view:

```
{ id, label, targetHost, eventTypes, status: active|disabled, disabledReason: delivery_failing|creator_revoked|null,
  createdAt, createdBy: { kind: service_account|personal_token|teammate, label },
  lastDelivery: { at, outcome: delivered|failed, statusCode|null } | null, failingSince|null }
```

The full target URL is never returned after create. A Zapier hook URL is a bearer capability.

Create errors:

| Status | Code |
|---|---|
| 400 | `invalid_target_url` (not https, or not public) |
| 403 | `event_type_not_permitted` |
| 409 | `event_subscription_limit_reached` |

## 10. Delivery (#1852)

**Runner (D8):** the generic background-job substrate (`shared/background-jobs/`) runs one job kind:
- kind `workspace_events.deliver`, payload `{ workspaceId, subscriptionId }`;
- `onDuplicateKey: "rerun"`, key = subscription id;
- `timeoutSeconds: 120`, `leaseSeconds: 180`.

At most one drain runs per subscription, so delivery is ordered and never concurrent per subscription.

A drain run:
1. Load the subscription. Stop if it is not active, or `next_attempt_at` is in the future.
2. Re-check the creator: the credential is not revoked or expired, its service account is active or the teammate is still a member, and the role still grants the permissions for every subscribed type. This is a narrow `EventSubscriptionOwnerCheck` port, adapted in composition from machineAccess and `workspaceRoleAllows`. If the check fails: disable with `creator_revoked`, audit, stop.
3. Read up to 50 events after the subscription cursor with the same horizon-safe reader as the API.
4. POST them in order:
   - 2xx: advance the cursor and record the delivery.
   - `410`: delete the subscription.
   - anything else (non-2xx, timeout, URL guard rejection): record the failure, set `next_attempt_at`, stop.
5. If more remain within the deadline, loop. Otherwise enqueue itself (rerun).

The job throws only for infrastructure errors, so the substrate's own retry and dead-letter path covers database outages, not targets.

**Waking the drain:**
- **Guarantee:** a new built-in periodic task `workspace-event-delivery`, every 60 s.
  - Locally the worker's poll loop runs it. On Cloud Run, a Cloud Scheduler entry in `infra/terraform/scheduler.tf` calls the existing `/internal/tasks/periodic-tasks/:taskId/run` route.
  - One indexed query finds active, due subscriptions with an eligible event after their cursor, and enqueues their drains.
- **Latency:** a best-effort post-commit wake, `WorkspaceEventDeliveryWake.requestDelivery(workspaceId)`, runs the same query scoped to one workspace. Two places call it:
  - the turn persistence's existing `afterCommit` (`postgresAssistantTurnPersistence.ts:512`), when the turn recorded an event;
  - the document worker after an event-bearing completion.
  A lost wake (deploy, CPU throttling) only delays delivery to the next sweep.

Worst case about 60 s. Typical for turn-borne events: seconds.

**Retry, backoff, disable:**
- Backoff is `min(30 s × 2^(n−1), 1 h)` over consecutive failures, stored as `next_attempt_at` and honoured by the sweep and the wake. The wake skips a subscription until it is due, so a busy workspace cannot hammer a failing target.
- Delivery is head-of-line: newer events wait behind a failing one and deliver in order once the target recovers.
- A subscription that has failed continuously for 24 hours, with at least 5 attempts, is disabled with `delivery_failing` and audited.
- Disabled subscriptions stay listed until deleted. There is no re-enable in v1; the connector re-subscribes and starts at the head.

**410:** the subscription is hard-deleted, the audit event `workspace_event_subscription.removed` (reason `target_gone`) is written, and the drain stops. This is Zapier's unsubscribe signal.

**Signing:** the webhook-skill recipe, unchanged.
- `createSignedWebhookHeaders` (`shared/infra/http/signedWebhook.ts:106-119`, re-exported at `modules/webhooks/delivery.ts`) sets:
  - `X-Radioso-Timestamp`;
  - `X-Radioso-Signature: sha256=hex(HMAC-SHA256(secret, "{timestamp}.{rawBody}"))`;
  - `Idempotency-Key: <event id>`.
- Receivers verify as `verifyWebhookSignature` (:121-136) does.
- Delivery is at-least-once. A crash after the POST and before the cursor write resends, so receivers dedupe on the key.

**Outbound URL guard:** the same composition the webhook skill executor uses (`app/server/builders/chat.ts:383-386`).

At create:
- `https` only;
- `assertPublicWebsiteUrl` (`modules/websiteCrawler/urlPolicy.ts:16`, DNS resolved).

The rule is extracted from `WebhookDestinationService.normalizeAllowedDestinationUrl` (`modules/webhooks/service.ts:342-358`) into `signedWebhook.ts`, so both use one rule.

At delivery, `FetchWebhookHttpClient(assertPublicWebsiteUrl, { fetchImpl: fetchPublicUrl, allowHttpLoopback })`:
- re-checks every hop;
- follows same-origin redirects only (≤3);
- connects through the DNS-pinned `fetchPublicUrl` (`shared/infra/http/publicUrlFetch.ts:60-83`);
- times out each POST after 10 s.

Loopback `http` is allowed only with `WEBHOOK_DESTINATIONS_ALLOW_HTTP_LOOPBACK` outside production (`app/config/env.ts:362`), for local n8n and e2e. There is no new env var.

The client throws a plain `Error` on non-2xx (`signedWebhook.ts:89-91`), so the status is unreadable. It gains a `WebhookResponseStatusError` carrying `status` only, with the same message. Existing callers are unaffected.

**Secrets:**
- Generated as `webhooks/service.ts:338` does (32 random bytes, base64url).
- Stored as `secret_ciphertext` through `encryptField` under `CONNECTOR_ENCRYPTION_KEY`.
- The target URL is stored as `target_url_ciphertext`, with `target_host` in plaintext for display.
- Both columns are added to `ENCRYPTED_FIELD_LOCATIONS`, so the rotation CLI covers them.
- Create fails `encryption_not_configured` without a key, as destinations do.

**Cap:** 25 subscriptions per workspace (active and disabled). It is enforced in the create transaction under a per-workspace advisory transaction lock.

**Delivery record for Settings:**
- The subscription row carries `last_delivery_at`, `last_delivery_outcome`, `last_delivery_status_code`, `consecutive_failures`, `failing_since`, `next_attempt_at`, `status`, `disabled_reason` and `disabled_at`.
- There is no per-delivery history table. The log already is the payload record, and metrics, spans and audit cover diagnosis.

**Settings:** a new **Event subscriptions** section on the **API access** tab (`frontend/components/dashboard/settings/settings-tab-metadata.ts`, `api-access-panel.tsx`).
- The list shows label, URL host, event types, which token created it, last delivery and outcome, and status.
- Delete goes through the existing `confirm-delete-dialog.tsx`.
- There is no create in Settings (epic: out of scope).
- `createdBy.label` is joined from the service account or personal token name at read time, so a rename shows.

## 11. Reuse versus new

| Existing | Verdict |
|---|---|
| `modules/webhooks/` (workspace webhook destinations) | **Kept separate.** Destinations are operator-authored, named, referenced by routines and skills (delete-blocking triggers), and secret-rotated. Subscriptions are created and removed by automation clients, owned by a credential, scoped to types, carry a cursor and failure state, and auto-delete on 410. One table would carry two lifecycles, and a 410 delete would fight routine references. **Reused:** the signer, the HTTP client, the URL rule (extracted), and the secret generation and encryption |
| `shared/observability/opsEvents/` | **Not reused.** It is platform telemetry to one env-configured URL through an in-memory queue, not durable and not tenant-scoped |
| `modules/audit` | **Not the log.** It is actor-attributed, content-free, kept 365 days, with no cursor. **Reused** to audit subscription create, delete, remove and disable |
| `notification_deliveries` cursor | A `(created_at, id)` UI cursor, not commit-safe. Only the opaque encoding (`shared/domain/cursorPagination.ts`) is reused |
| `conversation_activity` | **Reused twice:** its in-transaction recorder shape is the port's model, and its `handoff_requested` write is the handoff emit point (bridge) |
| `routine_action_requests` (action outbox) | Not reused for events. It holds one row per side effect for its own handlers. An event fans out to N subscriptions and must stay listable after delivery. Its `contact.send` rows are an emit source |
| `shared/background-jobs/` | **Reused** as the delivery runner. No new queue, no per-kind migration, no new env var |
| Retention sweep, eraser cascade, `MessageCopyWithholder` | **Reused** (§8) |
| Realtime invalidation (`GET /api/v1/events`) | Not reused. It is best-effort dashboard SSE |
| **New** | `workspace_events`, `workspace_event_subscriptions`, the recorder, log service, subscription service, drain handler, sweep task, owner-check port, routes, OpenAPI, and the Settings section |

**Queue and contract review (AGENTS.md):**
- The document worker's AMQP and Cloud Tasks message stays `{ jobId }`. Document events ride the worker's existing completion writes.
- The new job kind uses `background_jobs` and the `BACKGROUND_JOB_TASK_QUEUE_NAME` queue, so its rate limits (`infra/terraform/queue.tf`) are shared with summary refresh and Slack inbound. One drain per subscription bounds the load. See open question 6.
- The periodic task needs the Terraform scheduler entry. An unprovisioned scheduler degrades to post-commit wakes only, and never blocks startup.
- The public contract grows by the OpenAPI paths and the envelope, so the SDK snapshot is regenerated.
- No MCP, connector-api or worker payload changes.

## 12. PR plan

Migration numbers are as of `origin/main` (latest `263`). Each PR runs `db:types` and `db:schema`, renumbers if a sibling merges first, and regenerates the SDK snapshot after merging main.

### PR 1: #1851 log, API and conversation events

**Migration** `264_workspace_events.sql` creates `workspace_events`:
- `id uuid pk`, `workspace_id` (FK cascade), `position` identity, `tx_id xid8`;
- `type`, `version smallint`, `occurred_at`, `idempotency_key`;
- `conversation_id` (composite FK cascade), `agent_id`, `channel`, `caller_kind`, `visitor_id`, `document_id`, `data jsonb`;
- indexes: the two log indexes, the partial unique on `(workspace_id, idempotency_key)`, `occurred_at`, and `conversation_id`.

**Files:**

| Area | Files |
|---|---|
| Contract | `shared/domain/workspaceEventLog.ts`; `shared/infra/kysely/sqlHelpers.ts` (horizon) |
| Module and wiring | `modules/workspaceEventLog/{README.md,public.ts,eventLog.ts,readPermissions.ts,cursor.ts}`; `db/repositories/workspaceEventLogRepository.ts`; `app/composition/workspaceEventLog.ts`, `conversationActivity.ts`, `conversationRetention.ts`, `consentWithdrawal.ts`, `conversationIngest.ts`; `app/server/builders/infra.ts` |
| Emitters | `db/repositories/conversationRepository.ts`; `connectors/plugins/slack/{slackPersistence.ts,slackInboundJobComposition.ts}` (+ its caller); `chat/infra/postgresAssistantTurnPersistence.ts`; `chat/services/{workspaceEventLogDrafts.ts,approvalResumeTurn.ts,routines/deferredRoutineStore.ts}`; `chat/infra/contactRequestRecordingOutbox.ts`; `app/server/builders/chat.ts`; `conversationActivity/{workspaceEventLogBridge.ts,public.ts}`; `routines/{domain.ts,public.ts}`; `packages/conversation-engine/src/index.ts` (one export) |
| HTTP | `app/http/routes/workspaceEventRoutes.ts` + `routes/index.ts`; `app/http/openapi/{paths,schemas}/workspaceEvent*.ts`; `apiPrincipalRoutePolicy.ts`; `account/services/accountAccessService.ts` |
| SDK | `typescript-sdk/openapi/`, `typescript-sdk/src/generated/` |
| Ray | `tests/unit/operatorCopilot/catalogCoverage.ts`: `listWorkspaceEvents` as `permanent`. It is an automation feed over facts Ray reads through `conversation_transcript`, `conversation_history_search` and `needs_attention` |
| Docs | `docs-portal/content/api/workspace-event-log.mdx` (+ `_meta.js`); `operators/data-retention.mdx` and `deleting-conversation-data.mdx` (events kept 30 days, erased with their conversation); `docs/architecture/code-map.md` ("Workspace Events"); product-docs corpus resync if gated |

**Tests (TDD, business-level):**
- Integration (`workspace-event-log.integration.test.ts`):
  - a routine completion yields one `routine.completed` with a sensitive slot `[redacted]`;
  - a contact request (turn path and notify path) yields `contact_request.created`;
  - two open transactions committing out of order: paging misses nothing;
  - erasing a visitor removes their events;
  - Test Chat traffic records nothing;
  - retention removes old events;
  - withdrawal removes the withdrawn routine's events, also after its state expired.
- Unit: mappers, cursor codec, per-type permission filter.
- Contract: `workspace-event-log.contract.test.ts` (permissions, the takeover deny case, 403, 410 on an aged cursor, OpenAPI parse). The realtime SSE suite keeps `workspace-events.contract.test.ts`.
- Schema coverage tests (§8).

### PR 2: #1851 document events (merges after PR 3; closes #1851)

Split out to keep PR 1 reviewable. It touches only documents:
- `db/repositories/documentProcessingJobRepository.ts` (shrinks: extract `documentProcessingJobOutcomes.ts`);
- `documents/services/{documentProcessingWorker.ts,documentWorkspaceEvents.ts}`;
- composition wiring;
- worker integration tests (processed once per revision under a lease takeover; failed carries the code, not the message).

### PR 3: #1852 subscriptions, delivery and Settings (follows PR 1; its `scheduler.tf` entry needs a Terraform apply per stack before the image deploy)

**Migration** `265_workspace_event_subscriptions.sql`:
- `id`, `workspace_id` (cascade), `label` (check), `target_url_ciphertext`, `target_host`, `secret_ciphertext`, `event_types text[]`;
- `status`, `disabled_reason`, `disabled_at`;
- `created_by_kind` / `_credential_id` / `_service_account_id` / `_user_id`;
- `cursor_tx xid8`, `cursor_position bigint` (initialised at the horizon on create);
- the delivery columns (§10), `created_at`, `updated_at`;
- index `(workspace_id, status)`.

**Files:**

| Area | Files |
|---|---|
| Module | `modules/workspaceEventLog/{subscriptionService.ts,deliveryDrain.ts,deliveryJob.ts,deliverySweep.ts,ownerCheck.ts}`; `db/repositories/workspaceEventSubscriptionRepository.ts`; `db/repositories/encryptedFieldRepository.ts` |
| Transport | `shared/infra/http/signedWebhook.ts` (status error, URL rule); `modules/webhooks/service.ts` (uses the extracted rule) |
| Wiring | `app/composition/{workspaceEventLog.ts,backgroundJobHandlers.ts}`; `app/server/dependencies.ts` (baselined at 1451: handler argument and periodic task, kept line-neutral); `chat/infra/postgresAssistantTurnPersistence.ts` (wake in `afterCommit`); `documentProcessingWorker.ts` (wake); `infra/terraform/scheduler.tf` |
| HTTP | `app/http/routes/workspaceEventSubscriptionRoutes.ts`, OpenAPI, route policy |
| SDK | snapshot |
| Frontend | `settings-tab-metadata.ts`, `api-access-panel.tsx`, `event-subscriptions-card.tsx`, `lib/` API adapter; Playwright `tests/e2e/event-subscriptions.spec.ts` (list and delete) |
| Ray | read tool `list_event_subscriptions` (operators ask why an automation stopped). Create is a `permanent` exclusion (the secret is shown once to the client that verifies with it). Delete is `deferred` |
| Docs | the API page gains subscribing, verifying signatures, retries, 410 and disable; an operator note on Settings → API access |

**Tests:**
- Delivery and signature (verified with `verifyWebhookSignature`).
- Backoff progression.
- 410 removal.
- Disable after 24 h failing.
- Creator revoked disables.
- Cap answers 409.
- A private target is rejected.
- In-order head-of-line delivery.
- A wake never advances a due time.

PR 3 could split backend and frontend if the orchestrator prefers.

### Observability

**PR 1–2:**
- No per-event log line: volume, and payloads hold contact data.
- No write counter: it would count rolled-back writes. Volume is a `GROUP BY type` query.
- A `workspace_events.list` span (workspace id, filter size, returned count, tail or after).
- `workspace_events_cursor_expired_total`.
- Retention reuses `radioso_retention_rows_removed_total{table="workspace_events"}`.

**PR 3:**
- `workspace_event_deliveries_total{outcome}` (`delivered`, `failed`, `gone`, `blocked`, `creator_revoked`).
- `workspace_event_delivery_duration_ms{outcome}`.
- `workspace_event_delivery_lag_ms` (now − `occurredAt` at delivery, which captures horizon and backoff lag).
- A `workspace_event.deliver` span: subscription id, event type, status code, attempt. No URL, no body.
- Warn logs only on transitions: first failure of a streak, disable, removal, recovery. Each carries the subscription id, event id, status code and error class.
- Audit events: `workspace_event_subscription.{created,deleted,removed,disabled}`, with ids, label and host.
- Background-job metrics come with the substrate.

## 13. Open questions for the orchestrator

1. **The `conversation.started` emit point.** The repository is the only choke point for all four creation paths, but it needs the recorder at three constructions. The alternative is the four call sites, where web chat's `create` has no transaction to join. Accept the repository?
2. **Push latency.** Is a 60 s sweep plus post-commit wakes (turns, documents) acceptable for Zapier "instant" triggers? Ingest-path `handoff.requested` and `conversation.started` wait for the sweep, or for the first turn's wake.
3. **DSAR export.** Is a stated exclusion acceptable for `workspace_events`, or should the log add an export section?
4. **Decisions are session-only today.** `POST /api/v1/agents/:agentId/decisions/:handle/resolve` and the takeover, reply and handback routes are session-only (`apiPrincipalRoutePolicy.ts:353-369`). The epic lists them as API actions, so `decision.pending` is observable but not actionable by a token until that policy changes. That is outside this slice; it affects #1853 and #1854.
5. **`decision.pending.reason`.** It is the text the Inbox shows. PR 1 verifies the engine renders sensitive slots masked in it. If it does not, the field is dropped.
6. **Shared queue.** Deliveries share the background-jobs Cloud Tasks queue. Is that fine for v1, or do they need their own queue? A separate queue needs Terraform and, against the brief, a queue-name variable.
7. **Defaults.** Cap 25, retention 30 days, disable after 24 h. Change any?
8. **Document event volume.** Website crawls and connector syncs produce one `document.processed` per changed page. `sourceKind` lets automations filter. Is a per-source `source.synced` wanted instead or as well?
9. **PR count.** Four PRs (log + conversation events, document events, subscriptions + delivery + Settings), or fold PR 2 into PR 1?

## 14. What other slices need

- **#1853 n8n and #1854 Zapier:**
  - Treat a subscription whose `status` is not `active` as gone, and re-subscribe.
  - Start polling with no `after`, then keep `nextCursor`.
  - On `410 cursor_expired`, restart from the tail.
  - Dedupe on `id`.
  - Verify `X-Radioso-Signature` as above.
- **#1850 docs:** link the trigger pages to `docs-portal/content/api/workspace-event-log.mdx` once it ships.
