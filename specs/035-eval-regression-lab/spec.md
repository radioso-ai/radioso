# Feature Specification: Eval Regression Lab

**Feature Branch**: `035-eval-regression-lab`  
**Created**: 2026-04-02  
**Status**: Draft  
**Input**: User description: "Design an eval solution for Radioso that helps debug retrieval and conversation regressions when settings or algorithms change, including the ability to add an existing conversation to an eval dataset."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Replay A Stable Eval Dataset Against Retrieval Changes (Priority: P1)

As an operator changing retrieval settings, rewrite behavior, rerank behavior, support policy, or related pipeline logic, I want to replay a stable dataset of conversation turns and search cases so I can tell whether the change improved or degraded real behavior before trusting it in production.

**Why this priority**: This is the core product need. Without repeatable replay against a known dataset, Radioso operators still have to rely on intuition, isolated manual chats, or ad hoc screenshots when retrieval quality changes.

**Independent Test**: Can be fully tested by creating a dataset with representative eval cases, running it once against a baseline configuration and once against a modified configuration, and verifying that the system returns per-case scores, pass/fail outcomes, and a dataset-level summary that identifies regressions.

**Acceptance Scenarios**:

1. **Given** a workspace has an eval dataset with replayable cases, **When** an operator runs that dataset against the current workspace configuration, **Then** the system produces a bounded eval run with a per-case outcome and an aggregate summary.
2. **Given** a dataset is run against two different configurations or revisions, **When** the second run completes, **Then** the system highlights which cases improved, regressed, or remained unchanged.
3. **Given** a case expects grounded retrieval behavior, **When** the replayed outcome loses the expected supporting citation, source document, or refusal behavior, **Then** that case is marked as degraded rather than silently treated as acceptable.
4. **Given** a run includes multiple eval cases with conversation history, **When** the replay executes, **Then** each case uses the stored conversation context for that case instead of replaying only the final user question in isolation.

---

### User Story 2 - Add An Existing Conversation To An Eval Dataset (Priority: P1)

As an operator investigating a suspicious or valuable conversation from chat history, I want to promote that existing conversation, or selected turns from it, into an eval dataset so real regressions can be captured from production-like usage instead of being rewritten by hand.

**Why this priority**: This is the highest-leverage dataset creation path. The most valuable eval cases are often discovered after a real conversation exposed a weakness or a success worth preserving.

**Independent Test**: Can be fully tested by opening an existing conversation in chat history, adding one or more turns to an eval dataset, and verifying that the imported case can be replayed later with the same relevant prompt history and expected outcome fields.

**Acceptance Scenarios**:

1. **Given** an operator is viewing a saved conversation with user and assistant turns, **When** they choose to add a supported turn to an eval dataset, **Then** the system creates an eval case that preserves the relevant conversation history, selected query, and replay inputs needed for later evaluation.
2. **Given** a selected assistant turn includes retrieval trace and support-validation diagnostics, **When** it is added to an eval dataset, **Then** the import flow can seed expected evidence, citation, refusal, or answer-support expectations from that recorded turn without requiring the operator to retype them all.
3. **Given** an operator imports a conversation turn that should not preserve the exact prior answer text as a gold output, **When** the eval case is saved, **Then** the operator can keep retrieval-focused expectations while omitting strict answer-text matching.
4. **Given** a conversation contains sensitive or ephemeral details that should not become a durable eval artifact, **When** the operator imports the case, **Then** they can review and redact bounded case content before final save.

---

### User Story 3 - Debug Why A Case Regressed (Priority: P2)

As an operator debugging a failed eval, I want the system to show why the replay result changed, including retrieval-trace differences, support-policy differences, and key evidence mismatches, so I can identify the first stage where quality degraded instead of only seeing a low final score.

**Why this priority**: Radioso already has retrieval traces and support-validation diagnostics. An eval product becomes much more useful if it turns those artifacts into regression attribution rather than another opaque score.

**Independent Test**: Can be fully tested by creating a known regression between two runs and verifying that the comparison view identifies meaningful before/after differences in retrieval stages, candidate counts, citations, and support outcomes for the regressed case.

**Acceptance Scenarios**:

1. **Given** an eval case fails after a retrieval change, **When** the operator opens the case comparison, **Then** the product shows the prior and current retrieval traces or summaries side by side with meaningful differences called out.
2. **Given** the regression is caused by earlier retrieval behavior such as rewrite, candidate generation, filtering, rerank, or context selection, **When** the operator inspects the failed case, **Then** the debug view helps identify that earlier failure point rather than only blaming final answer text.
3. **Given** a case passes retrieval expectations but changes only in answer wording, **When** the operator inspects the result, **Then** the system distinguishes a wording drift from a retrieval or grounding regression.
4. **Given** support validation changed the delivered answer under `strict`, `warn`, or `off`, **When** the operator inspects the case, **Then** the active answer-support policy and its effect are visible in the eval diagnostics.

---

### User Story 4 - Define And Tune Case Expectations Without Turning Eval Into Prompt Art (Priority: P3)

As an operator maintaining eval quality, I want to define practical expectations such as expected citations, expected documents, expected refusal behavior, expected support-policy outcome, and optional answer checks so the eval suite stays robust as the model wording changes.

**Why this priority**: A useful eval suite must be maintainable. If every case depends on brittle exact-answer matching, the suite will create noise and people will stop trusting it.

**Independent Test**: Can be fully tested by creating cases with retrieval-only expectations, cases with strict answer checks, and cases with refusal expectations, then verifying that each case is scored according to its declared expectation type rather than one universal rubric.

**Acceptance Scenarios**:

1. **Given** an operator creates or edits an eval case, **When** they choose retrieval-focused scoring, **Then** they can define expected documents, citations, refusal behavior, and support outcomes without being required to store a gold answer paragraph.
2. **Given** an operator wants a stronger assertion for a narrow case, **When** they configure answer-level expectations, **Then** the system can apply bounded answer checks in addition to retrieval expectations.
3. **Given** a case imported from chat history contains a good answer but a non-essential phrasing detail, **When** the operator saves the case, **Then** they can disable brittle exact-text comparison while keeping the important retrieval expectations.
4. **Given** an eval run completes, **When** the system computes results, **Then** it scores each case using only the expectation dimensions explicitly configured for that case.

### Edge Cases

- What happens when an imported conversation predates retrieval-trace capture or has partial diagnostics only?
- What happens when a case imported from chat history references documents or settings that were later deleted, reprocessed, or materially changed?
- How does the system behave when a conversation contains many turns and only a subset should be preserved as replay context?
- What happens when an eval case uses anonymous/public chat history rather than an authenticated conversation?
- How does the system handle cases where the original turn succeeded only because of a now-fixed bug or accidental leakage that should not become the gold baseline?
- What happens when a run compares two results that use different answer-support policies such as `strict` versus `warn`?
- How does the system prevent long-running eval datasets from becoming an unbounded analytics or benchmark platform rather than a focused regression tool?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.
- Backend API contracts MUST remain code-first and any HTTP contract change must regenerate generated OpenAPI artifacts instead of hand-editing them.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat history routes and presenters remain responsible for conversation retrieval only; dedicated eval routes and presenters own eval transport contracts; focused eval services own dataset import, replay orchestration, scoring, and comparison behavior; existing retrieval and chat services remain responsible for executing chats and producing trace or validation diagnostics; repositories remain persistence-only.
- **Encapsulation Rule**: `backend/src/modules/chat/services/chatService.ts` MUST remain chat orchestration-only and MUST NOT absorb dataset management, eval scoring, or run-comparison logic. Existing retrieval-trace modules MUST remain the source of retrieval execution facts rather than being reformatted ad hoc in frontend code. `frontend/components/dashboard/chat-history-view.tsx` MUST remain a diagnostics and history surface rather than becoming the owner of eval-run state.
- **New Seams Required**: Introduce a focused eval domain with at least dataset management, conversation-to-case import, replay execution, scoring policy, and run-comparison seams. Introduce a bounded case-expectation model that supports retrieval expectations, refusal expectations, support-policy expectations, and optional answer-level checks without forcing one universal rubric.
- **Anti-Goals**: Do not build a generic cross-workspace analytics platform in this feature. Do not reduce eval results to only one opaque LLM-judge score. Do not require exact final-answer text for every case. Do not duplicate retrieval execution logic inside the eval module when the existing chat and retrieval services can be replayed through stable seams. Do not store unrestricted raw prompts, secrets, or full document bodies inside eval artifacts.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow a workspace to create and manage one or more eval datasets composed of replayable cases.
- **FR-002**: The system MUST allow an eval case to represent either a standalone retrieval-backed question or a question with preserved prior conversation context.
- **FR-003**: The system MUST allow operators to add one or more existing conversation turns from chat history into an eval dataset.
- **FR-004**: When importing a conversation turn into an eval dataset, the system MUST preserve the bounded replay inputs needed to rerun that case later, including the selected user query and the relevant preceding conversation context.
- **FR-005**: The conversation-import flow MUST allow the operator to review and redact bounded imported content before it becomes a durable eval case.
- **FR-006**: When a selected historical turn includes stored retrieval-trace or support-validation diagnostics, the import flow MUST be able to seed eval expectations from those diagnostics.
- **FR-007**: The system MUST support retrieval-focused expectations for an eval case, including expected source document identity, expected citation identity, expected refusal or no-context behavior, and expected answer-support outcome where applicable.
- **FR-008**: The system MUST allow an eval case to omit strict gold-answer text matching while still being scored on retrieval and grounding dimensions.
- **FR-009**: The system MUST support optional answer-level expectations for cases where answer content should be checked in addition to retrieval or refusal behavior.
- **FR-010**: The system MUST allow an operator to run an eval dataset against the current workspace behavior and persist a bounded eval-run result for later inspection.
- **FR-011**: The system MUST support comparing one eval run to a prior baseline run for the same dataset and identifying per-case outcomes as improved, regressed, unchanged, or newly unscored.
- **FR-012**: The system MUST produce a dataset-level summary that reports aggregate pass/fail counts, regression counts, improvement counts, and any skipped or invalid cases.
- **FR-013**: For each eval case, the system MUST retain bounded replay diagnostics sufficient to explain the outcome, including retrieval trace or retrieval summary when available, support-validation outcome when available, and scoring details for each configured expectation dimension.
- **FR-014**: The system MUST expose a per-case comparison view that helps operators understand why a case regressed by showing meaningful before/after differences in retrieval and answer-support behavior.
- **FR-015**: The comparison experience MUST distinguish retrieval regressions from answer-only wording drift when retrieval expectations still pass.
- **FR-016**: The system MUST preserve the active answer-support policy outcome in eval diagnostics so runs can reveal the effect of `strict`, `warn`, or `off`.
- **FR-017**: The system MUST support importing cases from authenticated chat history and from anonymous/public chat history when the current operator is authorized to inspect that history.
- **FR-018**: The system MUST fail safely when a historical conversation lacks full trace or validation metadata by preserving a usable case with explicit unavailable expectations rather than blocking import entirely.
- **FR-019**: The first release MUST prioritize deterministic and product-specific scoring dimensions before any optional LLM-judge scoring.
- **FR-020**: If LLM-judge scoring is introduced later, it MUST be additive to deterministic scoring and MUST NOT be the only verdict presented for a case.
- **FR-021**: The system MUST keep eval datasets and runs workspace-scoped so one workspace’s eval artifacts do not affect another workspace.
- **FR-022**: The system MUST preserve enough metadata to identify which workspace settings or revision a run used, without requiring the product to become a full version-control system.
- **FR-023**: The system MUST provide automated coverage for dataset import, replay execution, scoring, and regression comparison, including at least one case imported from existing conversation history.
- **FR-024**: The system MUST keep eval run data bounded in product-facing views and storage contracts rather than persisting unrestricted logs or full raw model transcripts for every step.

### UI Tasks

- The dashboard must provide an eval-focused surface where operators can browse datasets, run them, and inspect summaries.
- The chat history experience must provide an operator path to add an existing conversation turn to an eval dataset.
- The import flow must let operators choose how much prior context to preserve, review the imported case, and redact or simplify it before saving.
- The eval case editor must make retrieval-focused expectations first-class so operators are not forced into brittle gold-answer authoring.
- The eval run comparison experience must surface retrieval-trace and support-policy differences in readable product language rather than raw backend logs alone.

### Key Entities *(include if feature involves data)*

- **Eval Dataset**: A workspace-scoped collection of replayable eval cases intended to guard against retrieval and conversation regressions.
- **Eval Case**: One replayable scenario containing the user query, optional preserved conversation context, bounded replay inputs, configured expectation dimensions, and provenance such as manual creation or conversation import.
- **Eval Case Expectation**: The configured criteria for a case, such as expected documents, expected citations, expected refusal behavior, expected answer-support outcome, and optional answer-level checks.
- **Conversation Import Draft**: The operator-reviewed intermediate representation created when promoting a historical conversation turn into an eval case, including redactions and selected context boundaries.
- **Eval Run**: One execution of an eval dataset against a particular workspace configuration or revision, containing per-case outcomes and an aggregate summary.
- **Eval Case Result**: The scored outcome for one eval case within an eval run, including pass/fail status, configured dimension results, and bounded replay diagnostics.
- **Eval Run Comparison**: The before/after representation that compares two runs of the same dataset and highlights regressions, improvements, and diagnostic differences.

## Assumptions

- The existing chat, retrieval trace, and answer-support infrastructure already provides the right execution seam for replay, so this feature should reuse that path rather than reimplementing retrieval in a separate eval engine.
- The highest-value initial scoring dimensions are deterministic and product-specific: citation presence, expected document hit, refusal correctness, support-policy outcome, and bounded latency or availability checks where appropriate.
- Exact-answer text matching is optional and should be used sparingly because Radioso’s most important regressions are retrieval and grounding regressions, not harmless wording drift.
- Imported conversation cases may need human review before becoming durable gold cases because real historical turns can include noise, accidental success, or content that should be redacted.
- The first release is a workspace-scoped regression lab, not a cross-workspace benchmarking service, public leaderboard, or arbitrary analytics warehouse.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operators can create a replayable eval case from an existing saved conversation turn, including preserved context, in representative validation flows without manual JSON editing.
- **SC-002**: For representative retrieval changes, the eval comparison flow identifies at least one concrete per-case reason for each introduced regression, such as citation loss, document mismatch, refusal mismatch, support-policy change, or earlier retrieval-stage degradation.
- **SC-003**: Covered eval runs can report per-case and aggregate outcomes for retrieval-focused datasets without requiring exact final-answer matching for every case.
- **SC-004**: At least 90% of imported conversation cases with available trace metadata can seed one or more useful expectation fields automatically during validation.
- **SC-005**: Covered regression tests confirm that a dataset replay can distinguish unchanged retrieval behavior from answer-only wording changes when retrieval expectations still pass.
- **SC-006**: Automated coverage includes at least one authenticated conversation import case, one anonymous/public conversation import case if such history is supported in the workspace, one regression comparison, and one case with missing historical diagnostics that degrades safely.
