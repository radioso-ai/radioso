# Feature Specification: Conversation Eval Harness

**Feature Branch**: `064-conversation-eval-harness`
**Created**: 2026-05-23
**Status**: Draft
**Input**: User description: "Design a simple eval functionality. Send a conversation to an eval and: (1) change the model and let a different model answer, (2) have an LLM-as-judge rate some percentage of conversations, (3) some deterministic evaluation — when a conversation didn't retrieve a result, enter the missing data and push the conversation through eval again."

**Scope Note**: This spec covers the first delivery of an eval harness inside OSS. It defines the **snapshot + replay + saved-case** primitive plus a single deterministic outcome check (retrieval gap closure). LLM-as-judge grading, sampled background evals, scheduled runs, dataset import/export, and answer-quality grading are explicitly deferred to follow-on specs so the substrate can be designed without committing to those product surfaces.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Close A Retrieval Gap (Priority: P1)

As a workspace operator reviewing a conversation where the assistant failed to ground its answer, I want to capture that conversation as an eval case, add the missing document, and verify the new corpus produces the expected retrieval — so I can prove the gap is closed before I trust the fix in production.

**Why this priority**: Retrieval gaps are the highest-leverage failure mode for a grounded assistant. A closed loop from "bad conversation" to "fixed corpus" is the most Radioso-specific value an eval feature can deliver, and it does not require any non-deterministic grading.

**Independent Test**: Can be tested by sending a known-failing conversation to eval, asserting the original retrieval did not include any chunk from a target document, adding that document to the workspace, re-running the snapshot, and asserting the new retrieval contains a chunk from the target document.

**Acceptance Scenarios**:

1. **Given** a conversation where the assistant's last turn returned no grounded answer, **When** the operator captures it as an eval case from the conversation trace view, **Then** an eval snapshot is created that immutably stores the messages, the original retrieval result, the original composed assistant instructions, the model id used, and the retrieval settings in effect at capture time.
2. **Given** an eval snapshot for a failed conversation, **When** the operator adds a previously missing document to the workspace and re-runs the snapshot in retrieval-only mode against the current corpus, **Then** the run records the new retrieval result and a side-by-side diff against the snapshot's original retrieval.
3. **Given** an eval case with expected outcome `retrieval_includes_document(documentId)`, **When** a run is executed and the named document appears in the new retrieval result, **Then** the case status becomes `passing` and the run outcome is `pass`.
4. **Given** an eval case with expected outcome `retrieval_includes_document(documentId)`, **When** a run is executed and the named document does not appear in the new retrieval result, **Then** the case status becomes `failing` and the run outcome is `fail` with a structured reason identifying that no chunk from the target document was retrieved.

---

### User Story 2 - Try A Different Model Or System Prompt (Priority: P1)

As a workspace operator iterating on assistant behavior, I want to replay a real conversation against a different model or different assistant instructions and see the resulting answer next to the original, so I can compare without affecting the live conversation.

**Why this priority**: Model and instruction changes are the next most common reason an operator wants "what if?" — they have no automated grading in v1, but the substrate (snapshot + parameterized run) is the same as User Story 1 and falls out for free if designed correctly.

**Independent Test**: Can be tested by capturing a conversation snapshot and running it twice with different `modelOverride` and `instructionsOverride` values, asserting both runs are persisted with the override that produced them and the resulting answer plus retrieval are diffable against the snapshot.

**Acceptance Scenarios**:

1. **Given** an eval snapshot, **When** the operator submits a full-replay run with a `modelOverride`, **Then** the run executes the full assistant pipeline (instructions + retrieval + LLM) using the overridden model and records the answer, retrieval result, and resolved configuration.
2. **Given** an eval snapshot, **When** the operator submits a full-replay run with an `assistantInstructionsOverride` (custom instruction, response identity, or response language policy), **Then** the run composes assistant instructions with the override applied and records the composed instruction block that was used.
3. **Given** a full-replay run, **When** the run completes, **Then** the eval UI presents a side-by-side diff against the snapshot's original answer and retrieval result with no automated pass/fail verdict.
4. **Given** a run that fails because of an LLM provider error or invalid override, **When** the run completes, **Then** the run is recorded with status `error` and an operator-readable error reason; the eval case status is unchanged.

---

### User Story 3 - Keep Fixes Fixed (Priority: P1)

As a workspace operator, I want previously fixed eval cases to stay fixed across configuration changes, so a future settings tweak that silently regresses retrieval is caught the next time the case is run.

**Why this priority**: Without persistence and re-runnability, every eval is one-shot and nothing compounds. The minimum bar for this v1 is that an operator can manually re-run a saved case at any time and see whether it still passes. Automated triggering on configuration change is deferred to a later spec.

**Independent Test**: Can be tested by creating an eval case with a `retrieval_includes_document` outcome, running it to passing status, changing the workspace's retrieval settings in a way that no longer surfaces the target document, manually re-running the case, and asserting the case transitions from `passing` to `failing` with a recorded run that documents the new retrieval.

**Acceptance Scenarios**:

1. **Given** a saved eval case in `passing` status, **When** the operator re-runs the case, **Then** a new run record is created against the same snapshot, the case's `lastRunId` and `status` are updated, and prior run history is retained.
2. **Given** an eval case that has transitioned between passing and failing across multiple runs, **When** the operator opens the case detail view, **Then** they see the ordered history of runs with timestamps, overrides applied, and outcomes.

---

### Edge Cases

- What happens when an operator tries to capture a snapshot from a conversation that predates retrieval-context persistence and therefore has no original retrieval chunks to freeze?
- What happens when the document named in a `retrieval_includes_document` outcome is deleted from the workspace before a re-run?
- What happens when a snapshot's referenced agent is deleted or renamed after capture?
- What happens when the retrieval settings schema evolves and a stored `retrievalSettingsOverride` no longer parses?
- What happens when a model named in `modelOverride` is no longer available in the provider registry?
- What happens when two operators run the same case concurrently?
- What happens when retrieval returns hundreds of chunks and the snapshot or run record would exceed reasonable row sizes?
- What happens when an eval run is launched against a snapshot from a different workspace by a misconfigured caller?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js and TypeScript.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Customer data MUST be protected with least-privilege access and secure transmission. Eval snapshots inherit the workspace access boundary of their source conversation.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, persistence, and replaceable runtime adapters. The eval module composes existing assistant, retrieval, and document ports and MUST NOT reach into their internals.
- Runtime LLM prompt templates MUST live under `backend/prompts/`. No new runtime prompts are required by this spec.
- User-facing assistant or chat responses produced during eval runs MUST flow through the same LLM path as production answers; eval MUST NOT introduce hard-coded conversational copy.
- Public contract changes MUST update the code-first OpenAPI registry, generated OpenAPI artifacts, SDK types, and relevant docs.
- Contract changes MUST include message-queue impact review. Eval runs are synchronous in v1 and do not enqueue worker payloads; if asynchronous runs are introduced later, that work belongs in a follow-on spec.
- Documentation MUST be updated to describe the eval surface, including how to capture a snapshot, save a case, run with overrides, and interpret outcomes.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The eval module owns eval snapshots, cases, runs, outcomes, and the orchestration that turns a snapshot plus overrides into a run. It MUST NOT own persona logic, prompt composition rules, retrieval strategy, LLM provider details, or document storage. Those remain in their existing modules and are consumed through narrow ports.
- **Encapsulation Rule**: The eval module MUST consume the assistant pipeline through the same composable services used by chat (`AssistantInstructionBuilder`, `RetrievalPipelineService`, chat gateway). It MUST NOT duplicate instruction composition, retrieval orchestration, or model resolution. Route handlers in the eval module MUST NOT format LLM payloads directly.
- **Source Of Truth Rule**: Snapshots are immutable inputs. Runs are append-only records of (snapshot + overrides + observed output + outcome). The case record is a derived projection of its latest run's outcome and MUST be rebuildable from the run history. The document corpus is always read at current state; corpus state is intentionally not versioned by this spec.
- **Snapshot Fidelity Rule**: A full-fidelity snapshot requires that the source conversation's assistant turns persisted the retrieval chunks, model id, and composed assistant instructions at the time the turn was answered. Conversations that lack this metadata MAY be snapshotted with messages only and a `fidelity: "messages_only"` marker; deterministic outcome checks that depend on the original retrieval result MUST be rejected for messages-only snapshots.
- **New Seams Required**:
  - Add `retrievalSettingsOverride?: Partial<RetrievalSettingsRecord>` to `RetrievalPipelineRequest` and thread it through `RetrievalContextStage` so the eval module can run retrieval without mutating workspace settings.
  - Persist per-assistant-turn retrieval context (retrieved chunks, model id used, composed instructions) on assistant messages going forward, so future conversations are snapshottable at full fidelity. The exact shape (extension of `MessageRecord.metadata` vs. a sibling `assistant_turn_context` table) is an implementation choice, but the data MUST be persisted at write time, not reconstructed.
  - Add an `EvalRunner` port inside the eval module that takes a snapshot plus overrides and returns a run result by composing the existing assistant and retrieval services. The runner MUST have two concrete modes: `retrieval_only` and `full_assistant`.
- **Anti-Goals**: Do not version the document corpus. Do not introduce an LLM-as-judge or automated answer-quality grader in v1. Do not introduce scheduled background evals, sampled production traffic evaluation, dataset import/export, or A/B test orchestration. Do not build a parallel chat pipeline inside the eval module. Do not store raw secrets, connector credentials, or any data the source conversation itself would not be permitted to expose.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Operators MUST be able to capture an eval snapshot from any conversation visible to them, identified by `conversationId` and an optional `messageId` marking the assistant turn under test.
- **FR-002**: An eval snapshot MUST immutably store the conversation messages up to and including the selected assistant turn, the original composed assistant instruction block, the model id used, the retrieval settings record id and resolved values in effect, the agent id in effect, and the original retrieval result for the selected turn when available.
- **FR-003**: When a source conversation lacks persisted retrieval context for the selected turn, the snapshot MUST be marked `fidelity: "messages_only"`. Otherwise the snapshot MUST be marked `fidelity: "full"`.
- **FR-004**: Operators MUST be able to attach an expected outcome to an eval case. v1 MUST support `retrieval_includes_document(documentId)`. The schema MUST be open for additional outcome types in later specs (e.g., `retrieval_excludes_document`, `manual_review`, `judge_score`).
- **FR-005**: Eval cases with deterministic outcomes (e.g., `retrieval_includes_document`) MUST be rejected against `messages_only` snapshots when the outcome depends on the original retrieval baseline. Snapshots with `fidelity: "full"` MUST accept all v1 outcome types.
- **FR-006**: Operators MUST be able to execute a run against a snapshot with overrides for: `modelOverride`, `assistantInstructionsOverride` (`customInstruction`, `responseIdentity`, `responseLanguagePolicy`), and `retrievalSettingsOverride` (any subset of the retrieval settings record).
- **FR-007**: Runs MUST support two modes: `retrieval_only` (executes retrieval pipeline only, no LLM call) and `full_assistant` (executes instruction composition, retrieval, and LLM answer generation).
- **FR-008**: A run's stored result MUST include the resolved configuration that was applied (model id used, composed instructions used, retrieval settings used), the observed output (retrieval result, and for full-assistant mode the generated answer and any citations), and the run status (`pass`, `fail`, `error`, or `recorded` when no automated outcome applies).
- **FR-009**: Deterministic outcome evaluation MUST be performed inside the eval module against the run's observed output. For `retrieval_includes_document(documentId)`, the check is satisfied when at least one chunk in the retrieval result has the named document id.
- **FR-010**: Full-assistant runs without a deterministic outcome attached MUST be recorded with status `recorded` and surface a side-by-side diff in the UI; they MUST NOT update the parent case's pass/fail status.
- **FR-011**: An eval case MUST track `status` derived from its latest run (`pending` when no run has executed, `passing`, `failing`, or `error`). The case MUST retain a complete ordered run history; runs MUST NOT be mutated after creation.
- **FR-012**: Eval snapshots, cases, and runs MUST be scoped to a single workspace. Cross-workspace access MUST be rejected by the authorization layer.
- **FR-013**: The retrieval pipeline MUST accept an explicit `retrievalSettingsOverride` parameter on `RetrievalPipelineRequest` and use it in place of the workspace's stored retrieval settings without mutating any persisted record.
- **FR-014**: New assistant turns MUST persist their retrieval context (retrieved chunk ids and ranks, model id used, composed instruction block) at the time the turn is committed, so that future eval snapshots from those turns can be captured at full fidelity. Backfilling historical turns is out of scope.
- **FR-015**: Eval runs MUST NOT mutate the source conversation, the source workspace's retrieval settings, the source workspace's agent records, or the document corpus. Runs MUST be safe to execute repeatedly.
- **FR-016**: Eval runs MUST be recordable even when the underlying LLM or retrieval call fails; failed runs are recorded with status `error` and a structured error reason, and MUST NOT change a case's pass/fail status.
- **FR-017**: Operators MUST be able to send a conversation to eval directly from the existing chat trace view. The entry MUST be a single action that creates a snapshot and navigates to the new case in one step.
- **FR-018**: An eval list view MUST show all eval cases in the current workspace with case name, status, snapshot source conversation, last run timestamp, and last run outcome reason when failing.
- **FR-019**: An eval case detail view MUST present the snapshot's original answer and retrieval alongside the latest run's answer and retrieval, with a clear diff for retrieval chunk presence and ranking.
- **FR-020**: Public OpenAPI, SDK types, and docs MUST be updated for the new eval endpoints in the same change that ships them.

### Key Entities *(include if feature involves data)*

- **Eval Snapshot**: An immutable capture of a conversation at a point in time, including messages, original assistant instruction block, model id, retrieval settings record id and resolved values, agent id, and original retrieval result for the selected assistant turn when available. Carries a `fidelity` marker.
- **Eval Case**: A named, persistent record that binds one eval snapshot to an expected outcome and tracks status derived from its latest run.
- **Eval Run**: An append-only record of a single execution against a snapshot, capturing the overrides applied, the resolved configuration used, the observed output, and the outcome verdict.
- **Eval Outcome**: A structured description of what a case is asserting. v1 ships `retrieval_includes_document(documentId)`. The schema is open for future outcome types.
- **Assistant Turn Context**: The per-turn record (or message-metadata extension) that persists retrieved chunks, model id, and composed instructions for an assistant message at the time it was answered. Required for full-fidelity snapshots of future conversations.

## Data Model Direction

The implementation SHOULD add tables equivalent to:

```sql
eval_snapshots (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  source_conversation_id UUID NOT NULL,
  source_message_id UUID,
  fidelity TEXT NOT NULL CHECK (fidelity IN ('full', 'messages_only')),
  messages JSONB NOT NULL,
  original_instruction_block JSONB,
  original_model_id TEXT,
  original_retrieval_settings JSONB,
  original_retrieval_result JSONB,
  original_agent_id UUID,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_by UUID
)

eval_cases (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  snapshot_id UUID NOT NULL REFERENCES eval_snapshots(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  expected_outcome JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'passing', 'failing', 'error')),
  last_run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

eval_runs (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL,
  snapshot_id UUID NOT NULL REFERENCES eval_snapshots(id) ON DELETE RESTRICT,
  case_id UUID REFERENCES eval_cases(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('retrieval_only', 'full_assistant')),
  overrides JSONB NOT NULL,
  resolved_config JSONB NOT NULL,
  observed_output JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'error', 'recorded')),
  outcome_reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
)
```

Persisting assistant turn context for future conversations SHOULD either extend `messages.metadata` with a typed `assistantTurnContext` field or introduce a sibling table keyed by `message_id`. Either choice MUST be opaque to the chat path's read API; only the eval module reads it during snapshot capture.

Exact table and column names may change during implementation, but the immutability of snapshots, append-only runs, derived case status, and the workspace scoping invariant MUST remain intact.

## API Direction

New endpoints SHOULD be added under `/v1/evals`:

```
POST   /v1/evals/snapshots                   { conversationId, messageId? } -> Snapshot
GET    /v1/evals/snapshots/{id}              -> Snapshot
POST   /v1/evals/cases                       { snapshotId, name, expectedOutcome } -> Case
GET    /v1/evals/cases                       -> Case[]
GET    /v1/evals/cases/{id}                  -> Case (with run history)
POST   /v1/evals/cases/{id}/runs             { overrides?, mode } -> Run
POST   /v1/evals/runs                        { snapshotId, overrides?, mode } -> Run   (one-off, no case)
GET    /v1/evals/runs/{id}                   -> Run
```

`Overrides` is an open object with optional `modelOverride`, `assistantInstructionsOverride`, and `retrievalSettingsOverride` fields. Unknown override keys MUST be rejected by Zod validation. `expectedOutcome` is a discriminated union with `type: "retrieval_includes_document"` in v1.

The frontend SHOULD add a "Send to eval" action on the existing chat trace view that calls `POST /v1/evals/snapshots` and navigates to the new case form, plus a workspace-scoped `/eval` route listing cases and a case detail route showing snapshot-vs-run diffs.

## Delivery Split

Implementation SHOULD be split into smaller, reviewable scopes:

1. **064a - Assistant Turn Context Persistence**: persist retrieved chunks, model id, and composed instructions per assistant turn at chat-write time. No eval surface yet. Backfill is out of scope.
2. **064b - Retrieval Settings Override Port**: thread `retrievalSettingsOverride` through `RetrievalPipelineRequest` and `RetrievalContextStage`. Add tests proving workspace settings are not mutated. No eval surface yet.
3. **064c - Eval Snapshot And Retrieval-Only Run**: introduce the eval module, snapshot capture, retrieval-only run mode, `retrieval_includes_document` outcome, case persistence, the chat-trace entry point, and the eval list/detail UI.
4. **064d - Full-Assistant Run And Override UX**: add `full_assistant` run mode, override editing UI, and side-by-side answer diff. Status remains `recorded` for full-assistant runs without a deterministic outcome.

## Assumptions

- The existing `AssistantInstructionBuilder.buildCombinedBlock()`, `RetrievalPipelineService.run()`, and chat gateway compose cleanly enough that the eval runner can drive them with explicit inputs without forking the pipeline.
- The chat trace view exists at a stable enough location in the frontend to host a "Send to eval" action; if it does not, that surface ships in 064c.
- Workspace authorization for evals can reuse the existing conversation/workspace access checks; no new permission scopes are introduced in v1.
- Operators are the primary users in v1; end-customer self-service eval is out of scope.
- The volume of eval snapshots and runs is low enough that synchronous run execution is acceptable; if that ceases to hold, asynchronous execution and worker dispatch are a follow-on spec.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can capture a snapshot from a chat trace view in one action, and the captured snapshot deterministically reproduces the original assistant turn's retrieval and instruction block when fidelity is `full`.
- **SC-002**: An operator can save an eval case with a `retrieval_includes_document` outcome and run it; when the named document is present in the new retrieval result, the case transitions to `passing`, and when it is absent, the case transitions to `failing` with a structured reason.
- **SC-003**: An operator can re-run a saved case after changing retrieval settings or adding/removing documents, and prior run history is retained.
- **SC-004**: An operator can replay a snapshot with a different model or different assistant instructions and view a side-by-side diff against the snapshot baseline.
- **SC-005**: New assistant turns created after 064a persist enough context to be captured at `fidelity: "full"`, and historical turns predating 064a are still capturable at `fidelity: "messages_only"`.
- **SC-006**: Running an eval against a workspace does not mutate that workspace's retrieval settings, agent records, document corpus, or source conversation, verified by integration tests that snapshot pre- and post-run state.
- **SC-007**: OpenAPI, SDK types, and operator docs ship in the same change as the eval endpoints they describe.
