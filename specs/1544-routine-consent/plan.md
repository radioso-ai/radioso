# Implementation Plan: Explicit consent before a sensitive slot (#1544)

Spec: `specs/1544-routine-consent/spec.md` (approved 2026-11-10). Decisions there are settled; items this plan believes need another look are in §10, not silently applied.

## 1. Design discipline

### What each piece knows, and what it must not

| Piece | Knows | Must not know |
|---|---|---|
| `packages/routine-definition/src/consent.ts` (new) | The authored shape: `key`, covered `slotKeys`, `variants[{locale, body, agreeLabel, declineLabel}]`, `onDecline: "continue" \| "handoff"`, limits; strict (persisted) and lenient (editing) variants | Locale fallback, slot validation, runtime, storage |
| `packages/conversation-contract/routineConsent.d.ts` (new) | Compiled `RoutineConsent {key, slotKeys, onDecline}`, step kind `"consent"`, `ConversationRoutineConsentPort`, `RoutineConsentEvent`, terminal kind `consent_declined`, reject reason `consent` | Wording storage, channels, models |
| `packages/conversation-engine/src/routineConsentGate.ts` (new) + `routineRunner.ts` | The gate as a state machine: blocked keys (covered, not granted at turn start), waived keys (declined/withdrawn), park/transit, two asks then default decline, decline choices | Wording text, locales, channels, SQL, models |
| `packages/conversation-defaults/src/routineConsentReplies.ts` (new) | Asking a model for `{"decision":"granted\|declined\|unclear"}` (safe default `unclear`) and for an answer to an unclear reply from the shown wording | Buttons, channels, records, slots |
| `backend/src/modules/routines/consentGates.ts` (new) | Where gates go (compiler), gate ids `consent:<key>:<stepId>` | Runtime decisions |
| `backend/src/modules/routines/consentValidation.ts` (new) | Authoring rules; adapts a consent to an `ExactContentItem` to reuse `validateExactContentItem` | Runtime |
| `backend/src/modules/routines/consent/consentTurnPort.ts` (new) | Host adapter of the engine port: picks a variant (Exact Words fallback), version hash, channel presentation, button verification, reader call, standing decisions through a narrow store port | SQL, HTTP, chat services |
| `backend/src/shared/domain/conversationSource.ts` | `consentPresentationFor(sourceChannel): "buttons" \| "text" \| "not_asked"` beside `callerKindForSourceChannel` (:56-59) | Consent text |
| `backend/src/shared/domain/chatInputMetadata.ts` (PR0, new) | The one vocabulary for how a visitor message was entered, with `suggestionId` added in PR2 | Consent |
| `backend/src/db/repositories/routineConsentRepository.ts` (new) | SQL: wording versions, records, standing lookup, latest-prompt lookup, writes inside the turn's transaction, exporter, retention rules | Runner logic |
| `backend/src/modules/privacy/consentWithdrawal.ts` (PR4, new) | Withdrawal use case over ports: lock+check record, erase covered values, withhold messages, mark record, audit | Routines, SQL |
| Chat (`chatTurnAssembly`, `conversationEngineChatTurn`, `chatTurnLifecycle`, `postgresAssistantTurnPersistence`) | Passes per-turn facts to the routine provider; carries `consentEvents` from engine result to persistence unread | Consent semantics |
| `frontend/lib/routine-consent-editor.ts` (PR3, new) | Pure editor transitions | React, HTTP |

### Ports and consumers
- `ConversationRoutineConsentPort` (contract): `standing({routine, turn}) → {asks, decisions}`, `read({routine, consent, turn}) → {decision, method, wording} | null`, `prompt({routine, consent, turn, reask}) → {reply: PendingRenderableTurn, wording} | null`.
  - Consumer: `DefaultRoutineRunner`. Implementer: `consentTurnPort.ts`, built per turn by `turnProvider.ts` (the same place that builds the selector and renderer, `turnProvider.ts:474-541`).
- `RoutineConsentTurnFacts` (owned by routines and re-exported from `chat/contracts/routineProvider.ts`, the same way `routineTurnState.ts` re-exports routines types per `chat/README.md:49-56`).
  - Fields: conversationId, visitorId, sourceChannel, user message `{id, inputMetadata}`, preferred locales, agent default locale.
  - Chat produces it; `turnProvider.forTurn` consumes it.
- `RoutineConsentStore` (routines): `standing(...)`, `latestPrompt(...)`.
  - `RoutineConsentRepository` satisfies it structurally (precedent: `messageRepository.ts:794-805` satisfies the facets port), bound in composition.
- Shared ports: `DataSubjectDataExporter` (`ConsentRecordExporter`) and `ConversationDataRetentionRule` (`ConsentRecordRetention`, `ConsentWordingVersionRetention`).
- Privacy (PR4): `ConsentWithdrawalUnitOfWork`, implemented by `db/repositories/consentWithdrawalRepository.ts` and bound in `app/composition/consentWithdrawal.ts`.

### Dependency direction
- Engine → contract only. Defaults → contract.
- Routines → routine-definition, contract, defaults, shared/domain.
- Chat → routines (existing edge). Routines never imports chat.
- Privacy → shared/domain only; covered slot keys are stored on the record, so withdrawal never reads routines.
- `db/repositories` → shared/domain and satisfies module ports structurally (`conversationDataRetention.ts:31-35` states repositories must not reach up into modules).
- Composition assembles. No new edge into `src/app`, none from `shared` into `modules`.

## 2. Data model

### 2.1 Consent definitions: JSONB column, not tables
`ALTER TABLE routine_definition ADD COLUMN IF NOT EXISTS consents JSONB NOT NULL DEFAULT '[]'::jsonb` (catalog-only; `CHECK (jsonb_typeof(consents)='array')` added `NOT VALID` then validated).

Why a column, not tables:
- A consent is a nested aggregate that is always read and written whole with its routine.
- No query filters on its fields. Records copy what they need: key, version and slot keys.
- Precedents for structured JSON on routine rows: step `options`/`metadata` and `activation_coverage_criteria` (`routineDefinitionRepository.ts:241-243, 207`).
- Normalized tables would need three tables and roughly 30 lines in `replaceChildren` (`:938-1032`), in a file already at its 1,033-line ceiling (`file-size-baseline.json`).

Reading parses with the Zod schema and fails loudly. Silently dropping an invalid value, as `:307-309` does for coverage criteria, could leave a sensitive slot unguarded.

Schema (`packages/routine-definition`):
- `consents: z.array(routineConsentSchema).optional()` with no default, following the `exposure` precedent (`index.ts:499-501`), so stored rows and published snapshots without consents parse unchanged.
- The persisted schema is strict on structure (key pattern, `slotKeys.min(1)`, `variants.min(1)`, `onDecline` enum) and lenient on text (blank allowed and reported by the validator, matching `exactContent.ts:21-27`).
- The editing schema is lenient on everything (`index.ts:504-505` requires it).
- The row mapper reads the column with `routineConsentStoredSchema`: the persisted rules on every known field, unknown fields dropped, so a field a later version adds survives a rollback.
- The update schema keeps omission meaning "unchanged", so `mergeDraftInputWithExisting` preserves stored consents (`service.ts:118-137`).
- `index.ts` is 926 lines, so the schema goes in `consent.ts`, re-exported.

### 2.2 Wording versions (immutable)
```sql
CREATE TABLE routine_consent_wording_versions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,                -- canonicalContentHash({locale, body, agreeLabel, declineLabel})
  locale text NOT NULL, body text NOT NULL, agree_label text NOT NULL, decline_label text NOT NULL,
  first_shown_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id));
CREATE INDEX routine_consent_wording_versions_retention_idx ON routine_consent_wording_versions (workspace_id, first_shown_at);
```
- The id is a hash of the content (`shared/domain/canonicalContentHash.ts`; the privacy notice uses the same idea at `agents/privacyNotice.ts:67`). Content never changes: the upsert's `ON CONFLICT DO UPDATE SET id = EXCLUDED.id` writes the same id back, which locks the row for the turn so the retention sweep's `SKIP LOCKED` passes over it, or re-inserts it after a sweep that took it first.
- A unit test recomputes the hash of stored rows.
- Rows are written inside the turn's transaction both when shown and when decided (the decision re-upserts), so retention can never orphan a record.

### 2.3 Consent records
```sql
CREATE TABLE routine_consent_records (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  conversation_id uuid,            -- no FK: proof outlives the conversation (FR-014)
  visitor_id uuid,                 -- no FK: outlives the visitor
  routine_id text NOT NULL,        -- compiled routine id = definition id (compiler.ts:13)
  consent_key text NOT NULL,
  slot_keys text[] NOT NULL,       -- covered keys at decision time; withdrawal erases these
  wording_version_id text NOT NULL,
  locale text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('granted','declined')),
  method text NOT NULL CHECK (method IN ('button','reply')),
  defaulted boolean NOT NULL DEFAULT false,   -- declined after two unclear replies
  channel text,                    -- conversations.source_channel
  decision_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  decided_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz, withdrawn_by_account_id uuid, withdrawn_by_user_id uuid,
  FOREIGN KEY (workspace_id, wording_version_id) REFERENCES routine_consent_wording_versions(workspace_id, id),
  CHECK (withdrawn_at IS NULL OR decision = 'granted'));
CREATE UNIQUE INDEX routine_consent_records_decision_key ON routine_consent_records (conversation_id, routine_id, consent_key, wording_version_id);
CREATE INDEX routine_consent_records_retention_idx ON routine_consent_records (workspace_id, decided_at);
CREATE INDEX routine_consent_records_visitor_idx ON routine_consent_records (workspace_id, visitor_id) WHERE visitor_id IS NOT NULL;
CREATE INDEX routine_consent_records_message_idx ON routine_consent_records (decision_message_id) WHERE decision_message_id IS NOT NULL;
CREATE INDEX routine_consent_records_wording_idx ON routine_consent_records (workspace_id, wording_version_id);
CREATE INDEX routine_consent_records_agent_idx ON routine_consent_records (agent_id) WHERE agent_id IS NOT NULL;
```
- The unique index makes retried turns idempotent.
- The message index keeps erasure's `SET NULL` from scanning the table, since conversation erasure deletes messages by cascade.
- The wording index serves wording retention's "no record names it" check and the foreign key check when a version goes; the agent index does the same for the agent's `SET NULL`.
- No reply text and no values are stored.
- `withdrawn_by_account_id` / `withdrawn_by_user_id` follow `ConversationErasureActor` (`privacy/conversationErasure.ts:14-18`).

### 2.4 Coverage, export and retention
- **Erasure coverage** (`tests/integration/conversation-erasure-coverage.integration.test.ts`; the column regex at `:188` matches these columns): add three `retained` entries following the `usage_events` precedent (`:98-99`).
  - `routine_consent_records.conversation_id`: "Consent proof kept for legal claims (Art. 17(3)(e)); holds no content."
  - `routine_consent_records.visitor_id`: same reason.
  - `routine_consent_records.decision_message_id`: "SET NULL as its message goes."
  - No `ON DELETE RESTRICT` is reachable, so the "nothing holds back the cascade" test (`:243-260`) passes.
  - No eraser is needed. Workspace deletion cascades through `workspace_id`.
- **Export coverage** (`data-subject-export-coverage.integration.test.ts:26-37`): `routine_consent_records: { kind: "exported", section: "consent_records" }`.
  - `ConsentRecordExporter` follows `RoutineValueExporter` (`routineStateRepository.ts:210-235`).
  - Scope: `conversation_id = ANY(conversationIds) OR visitor_id = ANY(visitorIds)`, joined to versions.
  - Each row: record id, conversation, routine, consent key, decision, method, defaulted, channel, locale, wording version id, `wording{body, agreeLabel, declineLabel}`, `decidedAt`, `withdrawnAt`.
  - Registered in `app/composition/dataSubjectAccess.ts:36-46`.
- **Retention** (registered in `app/composition/conversationRetention.ts:28-37`):
  - `ConsentRecordRetention` deletes records whose conversation no longer exists, whose workspace has `conversation_retention_days` set, and whose `decided_at < now - days` (`SKIP LOCKED`, bounded). A conversation expires from its last activity, so a record stays as long as the conversation whose values it proves.
  - `ConsentWordingVersionRetention` deletes versions no record references, past the same window.
  - The doc comment on `ConversationDataRetentionRule` (`shared/domain/conversationDataRetention.ts:1-8`) gains one sentence: a rule may read the workspace's own window for proof kept past its conversation.

## 3. Runtime flow

### 3.1 Where the gate sits: a compiler-inserted gate step
In `compileRoutineDefinition` (`compiler.ts:100-289`), after the auto-gate (`:110-151`):
- For each consent and each chat step S that `collectedSlotsByStep` (`routine-definition/src/index.ts:651-680`) says collects one of its covered fields, emit step `{ id: "consent:<key>:<S>", kind: "consent", consentKey }`.
- Retarget every transition into S to that step, and add a default transition from it to S. If S is the root, it becomes the root.
- Two consents on one step chain in consent order.
- Compile `routine.consents = [{key, slotKeys, onDecline}]`.
- Authored ids match `routineIdentifierPattern` (`index.ts:87`), so a colon cannot collide.

Why a gate step and not runner state:
- The visitor is answering the gate, not S. Every runner rule tied to the current step then stays true: the re-ask count (`routineRunner.ts:1098-1104`), `sensitiveSlotsAwaited` (`routines/sensitiveSlots.ts:12-26`), and resuming at `path.at(-1)`.
- Using the shared collection rule means the consent "cannot be put in the wrong place".

`compileRoutineDefinition` validates first and throws on failure (`compiler.ts:101-105`). The consent rules therefore never run on the compile path (§6.2). The runtime compiles published snapshots there (`app/composition/routineDefinitionSource.ts:54`), so routines published before this feature keep serving.

### 3.2 Runner (engine)
Room is made in PR0. `routineRunner.ts` is at its 1,403-line ceiling.

At `claim` start, only when `routine.consents` is non-empty:
- Call `port.standing()` once.
- `blocked` = covered keys whose consent is not `granted` at turn start.
- `waived` = covered keys whose consent is `declined` (a withdrawn grant reads as declined).

How covered fields stay unfilled (FR-007, and the edge case of a value typed earlier):
- `checkDeclaredSlotValues` (`routineRunner.ts:262-287`) drops `blocked` keys with reject reason `consent`, added to `RoutineTraceRejectedSlot.reason` (`routineTrace.d.ts:113-116`).
- Every value enters through it: the activation extraction (`:534-535`), every selector call (`selectChecked`, `:590-611`) and fast-forward reads. So a covered value from before the grant, from the grant message itself, or from a direct-invocation input is never stored.
- A grant decided this turn does not unblock until the next turn.
- From the next turn on (option A, 2026-11-11), `RoutineConsentGate.grantedBefore` names the covered keys granted before the turn on a conversation that asks; the runner passes those still empty to the selector as `earlierMessageSlotKeys`, and the selector's `routine-next-step-earlier-slots.md` rule lets them take a value from the visitor's earlier messages, the grant message and messages from before the consent included. A reply that adds nothing keeps the earlier value.

Landing on a gate (the transit loop at `:1152` gains `"consent"`):
- **A decision exists** (standing, or this turn): `granted` → step to S. `declined` → `onDecline: continue` adds the covered keys to `waived` and steps to S; `handoff` ends the run (below).
- **No decision, `standing.asks` is false** (voice, calling agents): event `skipped{reason:"channel"}` and the decline path. No record (FR-009, US4-AS3).
- **No decision, wording available:** `port.prompt({reask:false})`. If it returns null (no variant reachable): `skipped{reason:"wording_unavailable"}` and the decline path. Otherwise park: `nextState` path ends at the gate, `status: "active"`, no re-ask count, reply = `prompt.reply`, event `asked`.
- **No port wired** (the kit, `conversation-kit/src/composition.ts:240-245`): `skipped{reason:"no_port"}` and the decline path. Safe by default.

Resuming on a gate (`!activationTurn && currentStep.kind === "consent"`), handled before the generic re-ask logic at `:1098-1135`:
- If standing has a decision, apply it.
- Otherwise `port.read()`. On `unclear` with fewer than 2 asks (asks = 1 + `reaskCount`): re-prompt with `reask:true` and stay with `reaskCount + 1`.
- `unclear` at 2 asks: `declined`, `defaulted:true` (FR-006, US3-AS4).
- `granted` or `declined` is applied as above. Emit `decided{decision, method, defaulted, wording}`.

Decline-to-handoff:
- A runner-owned ending `consent_declined`, modelled on `stuck` (`:1105-1135`). It enters no terminal step and runs no completion export. `collected` holds no covered value, because covered values never entered state.
- Reply: `prepareReply({step, steering: [], turn, stuckHandoff: true})`, which reuses `routine-step-stuck-handoff.md` ("a person will continue"). That prompt contains no consent copy.
- Add `consent_declined` to `RoutineTerminalKind` / `RoutineHandoffTerminalKind` (`index.d.ts:1090-1093`), `routineEnding.ts:51`, `ROUTINE_TERMINAL_KINDS` (`conversationEngineChatTurn.ts:557`), `handoffOwnership.ts:69` (reason `routine_consent_declined`), `operatorNoticeAction.ts:36-41` (the hand-off row with its own reason) and `handoff/ownershipState.ts:7`.
- Add an operator-facing headline in `operatorNotifications/routineEndingNotificationText.ts:14-29` saying the visitor declined consent. It carries no value.

Decline-to-continue: `isSlotCollectionStepSatisfied` (`slotCollectionStep.ts:31-47`) treats waived keys as satisfied, so the existing fast-forward leaves S by `satisfiedStepExit` (`routineRunner.ts:657-664`). Guards read the fields as absent because they are absent (US4-AS1). §10 adds the authoring rule that makes this always possible.

Effects: `consentEvents?: RoutineConsentEvent[]` follows `awaitingDecision`'s route: claim effects → `ConversationRoutineResumeResult` (`index.d.ts:1490`) → `routineResume.ts:133,232` → `ProcessTurnResult` (engine `index.ts:117`, `index.d.ts:1829`) → `conversationEngineChatTurn.ts:571-580` → `CompleteAssistantTurnInput`.
- `wording` carries `{versionId, locale, body, agreeLabel, declineLabel}` as a host value the engine passes through unread.
- The trace adds step events `consent_asked | consent_decided | consent_reused | consent_skipped` with keys only.

### 3.3 Verbatim wording and buttons
- **Variant:** the port builds `ExactContentItem {chips:["agree","decline"], variants:[{locale, body, chipLabels:{agree, decline}}]}` and calls `resolveExactContent` (`exactContent.ts:303-364`; the exact → base → default fallback is at `:324-331`). References resolve against an empty map, so the wording is literal.
- **Preferred locales** are tried in order: the turn plan's `responseLanguageTag` (`turnPlanService.ts:117`, observed through `turnLanguageReport.ts`), then the client hints `userExpectedLocale`, `pageLocale`, `browserLocale` (the greeting's order, `chatBootstrapService.ts:124-133`). The agent default is the fallback. Text channels carry no client hint, so the plan tag is what follows the visitor's language there.
- **`buttons` presentation** (anonymous link, embed, Test Chat, workbench replay, Ray probe, REST assistant API): `RenderableTurn {answer: body, suggestions:[{id:"agree", text, kind:"authored", action:{kind:"ask_followup"}}, {id:"decline", …}], metadata:{skillName, skillOutcome, skillStatus}}`.
  - `presentationFromRenderableTurn` already carries `suggestions` through (`routineGroundedAnswerRenderer.ts:133-170`, suggestions at :149).
  - The chips use `ChatSuggestion.id` (`chatResponses.ts:24-35`), shaped like the greeting chips (`chatBootstrapService.ts:393-398`). No text is added around the wording (US2-AS1).
- **`text` presentation** (email, WhatsApp, Slack): `answer = body + "\n\n" + agreeLabel + "\n\n" + declineLabel`, each label its own paragraph so markdown does not join them. This is layout only, no words. Slack and WhatsApp send `response.answer` as is (`slackMessageHandler.ts:530`, `whatsappMessageHandler.ts:301`).
- **Shown write:** event `asked` → persistence upserts the version and puts `consentPrompt {routineId, consentKey, wordingVersionId, locale}` on the assistant message's metadata.

### 3.4 Button click as a structured decision
- **PR0** consolidates the three copies of the input-metadata schema (`publicChatRouteSchemas.ts:62-84`, `assistantChatSchemas.ts:9-31`, `agentTurnProbe.ts:32-41`) and the stored parser (`messageRepository.ts:57-78, 217-254`) into `shared/domain/chatInputMetadata.ts`.
- **PR2** adds optional `suggestionId` (a chip id). `public-chat-shell.tsx:833-849` sends `suggestion.id` through an extracted helper `frontend/lib/public-chat-suggestion.ts`; that shell is the one both the link and the embed render.
- **Server check** (`port.read`):
  - Accept the click only when `method === "suggestion_click"`, `suggestionId` is `agree` or `decline`, and `suggestionSourceMessageId` is the latest `consentPrompt` message for this (conversation, routine, consent) (`store.latestPrompt`).
  - The decision comes from the chip id; the visible label text is ignored. Method `button`, wording = that message's version, verified by recomputing the hash from the conversation's pinned definition.
  - Any mismatch (a stale prompt, a foreign message, an unknown chip) is read as a typed reply.
- **No nonce:** the source message id is the handle. It is an unguessable, server-issued id scoped to the conversation, and only the visitor's own session can send against it.

### 3.5 Typed replies
- `RoutineConsentReplyReader` in conversation-defaults follows `RoutineReentryGate` (`routineReentryGate.ts:32-47, 76-87`): `modelGateway.complete` with prompt `backend/prompts/chat/routine-consent-reply.md`.
  - The prompt shows the wording and both labels as data plus the visitor's latest message, and asks for JSON `{"decision": …}`.
  - It returns `granted` only for an unambiguous, unconditional agreement to the text shown, judged by meaning in any language. On any parse failure it returns `unclear`.
  - The prompt is registered in `scripts/generate-default-prompts.mjs` (the manifest; the reentry entry is at :115) and copied into `conversation-defaults/src/generated/defaultPrompts.ts`.
- The unclear answer uses prompt `routine-consent-unclear-answer.md`. It answers only from the shown wording, must not ask, restate, summarise, or say anything was agreed, and the verbatim wording and chips follow it (§10 item 3).
- Ask counting and the default decline live in the runner (§3.2), so they are deterministic.

### 3.6 Reuse within the conversation
- `standing()` returns decisions from records for (conversation, routine, key) whose `wording_version_id` is the version of any variant of the consent as the conversation's pinned revision holds it.
- So another collecting step, a re-run of the routine, or a revision migration to an edited wording are handled as US2-AS4 and the edge cases require (scoping in §10 item 5).
- Withdrawn → `declined` (US5-AS2).

### 3.7 Sensitive marking of consent replies
- `sensitiveSlotsAwaited` (`routines/sensitiveSlots.ts:12-26`; called at `chatSessionPreparer.ts:750-760`) and the reporter's `sensitiveSlotKeysAwaited` (`routineTurnReporter.ts:145-150`) map a gate step to its covered sensitive keys.
- So a reply like "yes, I'm pregnant" is marked when it is stored and read as withheld by every copy (`sensitiveTranscript.ts:14-35`, `chatSessionPreparer.ts:561-575`).

### 3.8 Persistence
- `postgresAssistantTurnPersistence.ts` (`completeAssistantTurn`, `:312-332`) calls `writeRoutineConsentEvents(db, input)` from `routineConsentRepository.ts`. It already imports repository helpers, for example the pending-decision repository at `:9`.
  - `asked` → upsert the version and stamp message metadata.
  - `decided` → upsert the version and insert the record with `decision_message_id = session.userMessage.id`, `channel`, `visitor_id`, `agent_id` and `slot_keys`.
  - A post-commit hook logs (§7).
- Review drafts run no routine (`chat/README.md:191-198`), and test or private replay turns follow their existing persistence rules.

### 3.9 Tool exposure
`exposure/agentToolDescriptor.ts` omits covered slots from a routine's tool input schema. They can never be supplied by a call, because agent channels never ask (§4) and startCheck blocks them.

## 4. Channels
- One rule in `shared/domain/conversationSource.ts`:
  - `voice` (`:31`) and `AGENT_SOURCE_CHANNELS` (`:36`: `mcp`, `agent_api`, `a2a`) → `not_asked`.
  - `email`, `whatsapp`, `slack` → `text`.
  - Every other channel, including null → `buttons`.
- Voice is detected from the conversation's `source_channel`. The voice channel runs turns through chat with `sourceChannel: "voice"`, so `standing().asks === false` and the decline path runs with no record.
- Text channels read replies with the reader. There are no buttons on Slack or WhatsApp (spec US3).

## 5. Withdrawal (PR4)
**Endpoints:**
- `GET /api/v1/history/chat/{conversationId}/consents` (`workspace.history.read`) lists records with their wording.
- `POST /api/v1/history/chat/{conversationId}/consents/{consentRecordId}/withdraw` (`workspace.history.delete`, the permission erasure uses; `historyRoutes.ts:79-80, 231`).
  - Returns 200 `{consent}`; 404; or 409 `consent_not_withdrawable` with `reason: "declined" | "already_withdrawn"` (US5-AS3).

**`ConsentWithdrawalService`**, in one transaction:
1. Lock the record (`FOR UPDATE`) and check it is granted and not withdrawn.
2. `UPDATE routine_states SET variables = variables - slot_keys WHERE session_id = conversationId AND routine_id = routineId`. There is one row per conversation, completed runs included (`schema.sql:3722-3736`, PK `session_id` at `:6302-6306`).
3. Withhold carrying messages: rows whose `metadata_json.sensitiveSlotKeys` intersects `slot_keys` (`messageRepository.ts:812-822` reads the same marker).
   - Set `content` to the redaction marker and add metadata `withheld {reason:"consent_withdrawn", at}`. This overwrites the text, because keeping it would not erase the value (§10 item 8).
   - Delete their `message_facets` rows, as `postgresAssistantTurnPersistence.ts:271-273` does.
4. Set `withdrawn_at` and the actor.
5. Write audit event `routine_consent.withdrawn` `{conversationId, routineId, consentKey, recordId}` with actor account and user. No content.

**Race with a turn still running:** inside the turn's transaction, the consent writer strips covered keys of withdrawn records from the routine state it just saved. Both commit orders are then safe.

**Ray and MCP:** permanent exclusion `consentWithdrawalIsAPersons` in `tests/unit/operatorCopilot/catalogCoverage.ts`, beside `erasureIsAPersons` (`:214-219`, `:468-469`), for both operation ids.

**Frontend:** `frontend/components/dashboard/conversation-consents.tsx` in `conversation-drawer.tsx`, with a confirm dialog patterned on `delete-conversation-action.tsx`.

## 6. Authoring surfaces

### 6.1 Definition schema
Covered in §2.1. Codes are added to `routineValidationCodes` (`index.ts:47-85`), which feeds the OpenAPI enum (`agentSchemas.ts:609-614`):
- `sensitive_slot_without_consent` (location `slot:<key>`)
- `consent_slot_unknown`, `consent_slot_not_sensitive`
- `consent_slot_covered_twice` (location `slot:<key>`)
- `consent_key_duplicate`
- `consent_missing_default_variant`
- `consent_text_invalid` (blank, too long, invalid or duplicate locale, a `{{…}}` reference, identical labels; location `consent:<key>.variants[i].<field>`)
- §10 rules: `consent_step_mixes_fields`, `consent_step_needs_default_exit`

Each gets a safe message in `safeRoutineValidationMessages` (`validator.ts:42-48`), so publish errors name the field or consent (`toSafeRoutineValidationDiagnostic`, `:66-71`).

### 6.2 Where the rules run (publishing, not serving)
- `RoutineValidationContext` (`validator.ts:78-82`) gains `agentDefaultLocale?`. `consentDiagnostics()` runs only when it is present, the same pattern as the compile path not having the skill catalog (`:645-647`).
- Callers that pass it:
  - `assertCandidateSnapshotIsRunnable` passes `options.agentDefaultLocale` (`agentRevision.ts:171-182`). Both real callers send the live default locale (`agentRevisionRepository.ts:36-47, 147-148, 178-179`), so the candidate and publish gate checks against the agent's current language, like the greeting (`agentRevision.ts:200-215`).
  - `RoutineDefinitionService` gets the locale from the agent it already loads. Narrow `agentRepository` (`service.ts:60-62`) to `{assistantDefaultLocale}`; `AgentRecord` carries it (`agentRepository.ts:553`). It then passes the locale in `resolveServingContext` (`:451-472`; serves `validate` `:342-355`, `validateForDraftMutation` `:362-370`, `validateManyForServing` `:517-536`) and in `savedRoutine` (`:405`). Save responses are what the editor shows (`assistant-routines-section.tsx:743`).
- `compileRoutineDefinition` keeps calling with no context.
- PR2 ships the shape rules only. PR3 adds `sensitive_slot_without_consent` and the two §10 rules, once every surface can author a consent.

### 6.3 Routine document and editor
- PR2: `RoutineBlockDoc` (`routine-document/src/block-document.ts:70-79`) gains a `consents` passthrough in `routineToBlockDoc` / `draftFromBlockDoc` (`:147-238`, `:251-306`). Without it the strict editing parse would refuse to open the routine.
- The prose clipboard grammar (`tokens.ts`, ceiling 1,124) does not carry consents. A whole-routine paste omits the field and the server keeps the stored value. This limit goes in the docs.
- PR3 adds:
  - `frontend/lib/routine-consent-editor.ts` with add and remove consent, covered fields, variants and decline choice. It reuses the exact-greeting variant transitions (`frontend/lib/exact-greeting-editor.ts`).
  - `routine-consent-section.tsx`, rendered after Collected information (`routine-document-tab.tsx:294`).
  - `renameSlot` / `removeSlot` / `slotReferences` in `frontend/lib/routine-document-edits.ts` include consents.
  - A muted "Asks consent first" marker on collecting steps (`routine-document-rows.tsx`).

### 6.4 Ray (PR3)
- `routineFieldPatchSchema` (`authoringEdit.ts:35-89`) gains `consents`, replaced whole like `exposure`.
- `projectRoutineForReview` (`authoringEdit.ts:160`) and the `routine_definition` projection (`tools/routines.ts:266-273`) list consents.
- The `propose_routine_edit` description (`tools/routines.ts:394`) explains consents and says Ray uses only wording the operator gave, verbatim.
- `validate_routine` surfaces the codes with no change.
- Add one deterministic eval case in `backend/tests/fixtures/copilot-evals/cases.ts`.

### 6.5 Operator MCP
No new tools. `routine_definition`, `validate_routine` and `propose_routine_edit` are already eligible (`operatorCopilot/operatorMcpDisposition.ts`; `docs/operator-mcp.md`, Tool boundary). The docs gain the consent fields.

### 6.6 OpenAPI and SDK
- PR2: the definition schemas change through the shared schema (`agentSchemas.ts:587-659`); `AssistantChatRequest` and the public chat body gain `suggestionId`.
- PR4: history consent paths in `openapi/paths/historyPaths.ts`.
- Each PR runs `cd typescript-sdk && pnpm run sync`, regenerates `packages/radioso-mcp-server/src/generated/openapiTypes.ts`, and runs `pnpm --filter @radioso/product-docs sync` (corpus). The sensitive-slots change (41415b7ef) regenerated all three.

## 7. Observability
- **Logs** (post-commit, from the consent writer; fields: workspace, agent, conversation, routine, consent key, wording version, decision, method, channel; never wording, reply or values):
  - `routine_consent_shown` with `reask`
  - `routine_consent_decided`
  - `routine_consent_defaulted`
  - `routine_consent_skipped` with `reason` (channel, wording_unavailable, no_port); `wording_unavailable` is logged at error level
  - `routine_consent_withdrawn`
- **Counter:** `routine_consent_outcomes_total{outcome}` with outcome one of asked, granted, declined, defaulted, skipped, withdrawn. Low cardinality, so a drift in the grant rate shows up.
- **Audit:** `routine_consent.withdrawn` (§5).
- **Trace:** routine sub-trace events with keys only (§3.2).
- No new span; the existing turn and withdrawal request spans cover it.

## 8. Test plan (TDD for backend: write failing tests first)
- **Package unit tests**
  - `packages/routine-definition/tests/consent-schema.test.ts`
  - `packages/conversation-engine/tests/routineConsentGate.test.ts`
  - `packages/conversation-engine/tests/defaultRoutineRunner.consent.test.ts`. Cases: park at gate; standing reuse; click and typed grant; grant-message value not stored; earlier value dropped; unclear then re-ask, then defaulted decline; continue skips S and guards read absent; handoff ends `consent_declined` with no covered values; voice / no port / no wording take the decline path; withdrawn reads as declined with no re-ask; root gate on activation; direct-invocation input blocked.
  - `packages/conversation-defaults/tests/routineConsentReplies.test.ts`: prompt layout, parse, unclear default.
  - `packages/routine-document/tests/block-document.test.ts`: round trip.
- **Backend unit tests**
  - `tests/unit/routines/consentGates.test.ts`
  - `tests/unit/routines/consentValidation.test.ts`, including: no context → no rule; a legacy uncovered routine still compiles
  - `tests/unit/routines/consentTurnPort.test.ts`: button verification, stale message, locale fallback, text layout, channels
  - Extend `tests/unit/routines/sensitiveSlotsAwaited.test.ts`, `tests/unit/routines/routineTurnReporter.test.ts`, `tests/unit/routines/agentToolDescriptor.test.ts`, `tests/unit/chat-turn-lifecycle.test.ts`
  - `tests/unit/shared/conversationSource.test.ts`
  - PR3: `tests/unit/routine-authoring-edit.test.ts`, `tests/unit/operatorCopilot/copilot-routines-tools.test.ts`
  - PR4: `tests/unit/privacy/consent-withdrawal-service.test.ts`
- **Integration tests**
  - `tests/integration/routine-definition-repository-postgres.integration.test.ts`: consents round trip and snapshot
  - `tests/integration/routine-consent-records.integration.test.ts`: atomic turn write, idempotency, message `SET NULL`, export, both retention rules, workspace delete
  - Extend `tests/integration/conversation-erasure.integration.test.ts`: records survive, message link dropped
  - Both coverage tests
  - `tests/integration/routine-consent-chat.integration.test.ts`: through ChatService with a scripted model, click, typed reply and voice
  - PR3: `tests/integration/agent-revision-publication.integration.test.ts`: publish blocked when uncovered; a legacy published revision still serves
  - PR4: `tests/integration/consent-withdrawal.integration.test.ts`
- **Contract tests:** `tests/contract/openapi.contract.test.ts` (codes enum), `tests/contract/public-chat.contract.test.ts` (`suggestionId`), PR4 `tests/contract/history-consents.contract.test.ts`, and the route-coverage contract.
- **Scenario tests with the real mini model:** `backend/tests/live/routine-consent-reply.verify.test.ts`, following `tests/live/routine-correction-after-ending.verify.test.ts` (`gpt-5.4-mini`, skips without a key).
  - English and German: agree, decline, "ok", "what do you do with it?", agreement with a condition, "yes, I'm pregnant".
  - Asserts SC-003: no ambiguous or refusing reply is recorded as `granted`, and the grant message fills no field.
  - Runs through the production wiring by way of `tests/support/bookingConversationHarness.ts`.
- **Playwright** (mocked backend, the repo convention, see `frontend/tests/e2e/privacy-notice.spec.ts`):
  - PR2 `frontend/tests/e2e/routine-consent-embed.spec.ts`: wording plus two chips; clicking agree sends `suggestionId`, `suggestionSourceMessageId` and `suggestion_click`; the next reply asks the step.
  - PR3 `routine-consent-editor.spec.ts`
  - PR4 `consent-withdrawal.spec.ts`
  - Frontend unit tests: `frontend/tests/unit/routine-consent-editor.test.ts`, `routine-document-edits.test.ts`, `public-chat-suggestion.test.ts`.
  - The record itself is proven by the backend integration tests.

## 9. PR slicing

| PR | Content | Gate reasoning | ~Files |
|---|---|---|---|
| PR0 `refactor:` | Extraction only. Routine graph types: `index.d.ts` (2,169) → `routineGraph.d.ts`. Value and terminal helpers: `routineRunner.ts:252-439` → own files. Row mapping out of `routineDefinitionRepository.ts`. Input-metadata consolidation into `shared/domain/chatInputMetadata.ts` (shrinks `messageRepository.ts`). Sensitive-marking helpers out of `chatTurnLifecycle.ts` (`:622-650`). A routine-turn request builder out of `chatTurnAssembly.ts` (`:438`, `:660`). Routine provider wiring out of `builders/chat.ts` (`:665`) into `app/composition/routineTurnProvider.ts`. Suggestion helper out of `public-chat-shell.tsx`. Re-record `file-size-baseline.json` | No behavior change; knip-neutral | 24 |
| PR1 `feat(engine):` | Contract (`routineConsent.d.ts`, trace events, terminal kind), gate and runner, resume and result propagation, defaults reader and both prompts, generated defaults. Minimal backend fallout for `consent_declined` (§3.2) | Package entry exports are exempt from knip (`knip.json:79-85`); no routine compiles a gate yet | 24 |
| PR2 `feat(routines):` | Schema, migration 254 plus `db:types` / `db:schema`, repository, compiler gates, shape validation, host port, chips (`suggestionId`), channel presentation, persistence, exporter, retention, coverage entries, tool descriptor, block-document passthrough, OpenAPI/SDK/MCP types/corpus, docs on authoring through the API and what visitors see per channel, tests and Playwright | No validator demands a consent yet; the editor keeps API-authored consents | ~70 |
| PR3 `feat(routines):` | Editor UI, Ray patch and projection, operator MCP docs, the coverage rule and §10 rules, eval case, docs | The coverage rule ships with every authoring surface | 28 |
| PR4 `feat(privacy):` | Withdrawal endpoints, service, repository, audit, coverage-map exclusions, drawer panel, OpenAPI/SDK, docs | Self-contained | 32 |

Substrate changes that would shrink this:
1. **One routine-effects envelope** carried from claim to persistence. Today each effect, such as `awaitingDecision`, is threaded through about six hops: `index.d.ts`, `routineResume.ts:133,232`, `index.ts:117`, `conversationEngineChatTurn.ts:571-580`, the chat lifecycle and persistence. An envelope would make consent one field.
2. **The hub files at their size ceiling** (`chatTurnAssembly.ts`, `chatTurnLifecycle.ts`, `routineRunner.ts`, `index.d.ts`, `builders/chat.ts`, `dependencies.ts`, `messageRepository.ts`, `public-chat-shell.tsx`) charge every routine feature an extraction cost. PR0 pays it once.
3. **PR2 can split** "click as structured decision" (`suggestionId` and the frontend) into PR2b. In between, clicks are read by the reader and recorded with method `reply`, which is honest and shows no misleading UI.

### Adopted 2026-11-10

- PR0 also introduces the routine-effects envelope (substrate change 1): one object carried from claim to persistence, with `awaitingDecision` moved into it and no behavior change. PR1 adds `consentEvents` as one field of it.
- Click-as-structured-decision (`suggestionId`, frontend chips) moves to PR2b (substrate change 3).
- PR2 and PR3 merge before the next release is cut, so no release ships API-only consent authoring.
- Every §10 disagreement is accepted as proposed; the spec's "Plan review 2026-11-10" clarifications record them.

## 10. Open risks and points where the spec needs a decision

**Disagreements: needs EM approval**
1. **Decline-to-continue can't keep the "do not ask" promise in two cases.** If a step also collects fields outside the consent, it is still asked, and its authored instruction asks for the covered field too. If a step has no default exit, it cannot be skipped by structure.
   - Proposal: for `continue` consents, add `consent_step_mixes_fields` and `consent_step_needs_default_exit`.
2. **Mutable covered fields.** A covered field marked "editable after completion" would be corrected outside the gate.
   - Proposal: slot correction never writes a covered field, plus an advisory.
3. **"Answers what it can"** adds generated text before the repeated wording.
   - Proposal: the answer comes only from the shown wording under a constraining prompt; the verbatim wording and chips follow. The first ask stays verbatim only.
4. **Channels the spec doesn't name.**
   - Proposal: calling-agent channels (`mcp`, `agent_api`, `a2a`) never ask and take the decline path without a record, because a calling agent cannot give a data subject's explicit consent.
   - Proposal: Test Chat, Ray probes and the REST assistant API ask with chips.
5. **Reuse scope.**
   - Proposal: decisions apply per routine, and to any language variant of the same consent in the pinned revision. A language switch is not new wording.
6. **Identifiers after erasure.** The clarification's minimal list omits ids, but FR-010 lists them.
   - Proposal: keep `conversation_id` and `visitor_id` as plain ids so the proof can be attributed, and drop the message link. The alternative is SET NULL on both, which makes the record unlinkable.
7. **Ray and consent wording.** Ray drafting consent wording is model-written legal text.
   - Proposal: Ray proposes only wording the operator supplied, enforced by the descriptor and an eval case.

**Clarifications**
8. **Withdrawal overwrites message content.** Today's "withheld" marking only affects copies, so the value would otherwise survive. Copies held by the email channel (`email_thread_messages`, raw MIME for 30 days) need a per-module withholding port. Text already sent to Slack or WhatsApp stays with those providers; the docs state that limit.
9. **`defaulted` flag.** It is a new column, because the spec's method values are only `button` / `reply`.
10. **Operator notice copy.** The "declined consent" line is operator-facing copy (existing pattern), not visitor consent copy.

**Risks**
- **Agent bundle import** validates for serving (`agentBundleComposition.ts:189-195`). After PR3, old bundles with uncovered sensitive fields fail import. Confirm whether import publishes; if it only drafts, exempt it.
- **Agent default language changed after publish:** wording may become unavailable, and the decline path runs. The publish gate rechecks the language; consider a Needs-Attention signal.
- **Classifier errors:** the safe default is `unclear`; SC-003 is guarded only by the live suite and the nightly evals.
- **Latest-prompt lookup** reads message metadata within one conversation. The conversation index is enough; confirm with EXPLAIN.
- **Chips after a page reload:** verify that history replay restores routine-reply suggestions (`chatHistoryService.ts:710-720`).
- **`RoutineTurnReporter.statusFor`** (`routineTurnReporter.ts:42`) must read a gate step as open with no pending input.
- **Test Chat and Ray's probe render no chips** (found in PR2): both hand the operator a reply's text alone, so `consentPresentationFor` gives `workbench_replay` and `operator_copilot_probe` the `text` presentation. §10 item 4 and the spec's clarification ("Test Chat ... ask with buttons") assumed chips there. Test Chat keeps its decisions in its own continuation and records none.
- **Withdrawal racing an in-flight turn:** closed by the strip inside the turn's transaction (§5). The new messages of such a turn are marked but not overwritten; that is a residual gap to document.
