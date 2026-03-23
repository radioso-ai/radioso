# Feature Specification: Retrieval Pipeline Stages

**Feature Branch**: `021-retrieval-stages`  
**Created**: 2026-03-21  
**Status**: Draft  
**Input**: User description: "Split RetrievalPipelineService into cleaner stage interfaces"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintain Retrieval Flow Safely (Priority: P1)

As a backend engineer, I can change or extend one retrieval phase without re-reading or rewriting the full retrieval pipeline, so that the main retrieval flow remains understandable and safer to modify.

**Why this priority**: The current retrieval pipeline is the central orchestration path for retrieval quality, citations, and diagnostics. If the ownership boundaries stay unclear, every future retrieval change becomes riskier.

**Independent Test**: Can be fully tested by moving the major retrieval responsibilities behind explicit stage boundaries while keeping the retrieval pipeline entrypoint behavior unchanged for existing callers.

**Acceptance Scenarios**:

1. **Given** an existing caller invokes the retrieval pipeline, **When** the refactor is complete, **Then** the caller receives the same shape of retrieval result without changing how it calls the service.
2. **Given** a maintainer reads the retrieval pipeline orchestrator, **When** they inspect the file, **Then** they can identify each major retrieval phase and its owner without reading the full implementation of every phase inline.

---

### User Story 2 - Test Retrieval Stages Independently (Priority: P2)

As a backend engineer, I can test major retrieval phases in isolation, so that refactors and future retrieval changes can be validated with narrower, faster tests.

**Why this priority**: The architecture improvement only pays off if the stage boundaries create better test seams rather than just moving logic between files.

**Independent Test**: Can be fully tested by adding or updating tests that exercise individual retrieval stages and prove that orchestration does not need full end-to-end coverage for every internal change.

**Acceptance Scenarios**:

1. **Given** a retrieval stage such as query interpretation, candidate retrieval, or reranking, **When** an engineer runs the relevant backend tests, **Then** that stage can be validated without requiring the entire retrieval pipeline implementation to be exercised as one unit.
2. **Given** a future retrieval change targets one stage, **When** the engineer updates that stage, **Then** they can identify the focused tests that protect that behavior.

---

### User Story 3 - Preserve Module Ownership (Priority: P3)

As a technical lead, I can enforce which retrieval files remain orchestration-only and which files own domain behavior, so that the refactor reduces long-term complexity instead of distributing it chaotically.

**Why this priority**: Refactoring into stages can easily become interface sprawl or a new indirection layer unless ownership rules are made explicit.

**Independent Test**: Can be fully tested by reviewing the resulting module boundaries and verifying that domain logic, orchestration, and infrastructure concerns do not collapse back into one file.

**Acceptance Scenarios**:

1. **Given** the retrieval module after the refactor, **When** an engineer inspects the architecture, **Then** orchestration, domain decision-making, and persistence/infrastructure seams are clearly separated.
2. **Given** a proposal to add new ranking or query behavior later, **When** the engineer chooses where to place it, **Then** the spec-defined stage boundaries make the owning module obvious.

### Edge Cases

- A retrieval stage returns no candidates while downstream stages still need to produce a stable prompt and diagnostics payload.
- Query rewrite is not retrieval-eligible and the pipeline must preserve current fallback behavior without duplicating logic across multiple stages.
- A stage extraction introduces new interfaces but accidentally leaves `RetrievalPipelineService` responsible for the same detailed policy logic as before.
- Diagnostics and citations depend on intermediate stage outputs and must remain complete even if some stages are bypassed or produce empty results.
- The refactor creates too many tiny interfaces, increasing indirection without creating meaningful test or ownership seams.

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

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes and chat services remain callers of the retrieval pipeline only; retrieval orchestration remains in the retrieval module; stage-specific decision logic belongs in focused retrieval services or stage modules; vector and lexical search persistence access remains in retrieval infrastructure ports and repositories rather than orchestration code.
- **Encapsulation Rule**: [`backend/src/modules/retrieval/services/retrievalPipelineService.ts`](/Users/dm/conductor/workspaces/radioso/radioso-retrieval-stages-spec/backend/src/modules/retrieval/services/retrievalPipelineService.ts) MUST remain orchestration-focused and MUST NOT continue to own most query parsing, retrieval policy, scoring, rerank selection, prompt construction, or diagnostics assembly inline after the refactor.
- **New Seams Required**: The refactor MUST define explicit stage interfaces for settings/context preparation, query interpretation, candidate retrieval, candidate preparation/scoring, final context selection, prompt assembly, and diagnostics assembly. The final plan may keep small purely local transformations as non-injected helpers if they do not represent a meaningful ownership seam.
- **Anti-Goals**: Do not add LangGraph or another workflow framework for this refactor. Do not move retrieval logic into chat services or route handlers. Do not introduce interface-per-function indirection where a pure helper is sufficient. Do not change persistence schema or retrieval API contracts as a side effect of this architecture change.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST preserve the existing externally visible retrieval pipeline contract for callers that invoke the current retrieval pipeline entrypoint.
- **FR-002**: The system MUST restructure retrieval orchestration so that major retrieval phases are represented by explicit stage boundaries with clear responsibilities.
- **FR-003**: The system MUST keep `RetrievalPipelineService` as the top-level coordinator or an equivalent orchestration entrypoint, and that coordinator MUST delegate major retrieval behavior rather than implement most of it inline.
- **FR-004**: The system MUST define explicit stage ownership for at least these retrieval concerns: settings/context preparation, query interpretation, candidate retrieval, candidate preparation and constraint scoring, final context selection, prompt assembly, and diagnostics assembly.
- **FR-005**: The system MUST preserve current retrieval behavior for query rewrite handling, candidate retrieval, reranking, prompt generation, citations, and diagnostics unless a change is explicitly required to maintain equivalent behavior through the new stage boundaries.
- **FR-006**: The system MUST allow major retrieval stages to be tested independently with focused backend tests rather than requiring all retrieval behavior to be validated only through one orchestrator-level unit.
- **FR-007**: The system MUST document or encode which responsibilities remain pure local helpers and which become explicit stage interfaces so maintainers can extend the pipeline without reintroducing orchestration bloat.
- **FR-008**: The system MUST keep persistence and infrastructure concerns behind existing or equivalent ports, so stage modules do not directly absorb transport-layer or database ownership concerns.
- **FR-009**: The system MUST avoid introducing a new framework dependency solely to represent stage orchestration.
- **FR-010**: The system MUST keep retrieval diagnostics complete and structurally equivalent after the refactor, including stage-derived counts, statuses, and continuity decisions currently exposed to downstream consumers.
- **FR-011**: The system MUST ensure prompt assembly and citation preparation remain deterministic and compatible with current chat-answer rendering behavior after stage extraction.
- **FR-012**: The system MUST define module boundaries that make future retrieval extensions possible without requiring unrelated edits across the full retrieval pipeline orchestrator.

### Key Entities *(include if feature involves data)*

- **Retrieval Pipeline Orchestrator**: The top-level retrieval coordination entrypoint that sequences stage execution and returns the final retrieval result to callers.
- **Retrieval Stage**: A focused module with one major retrieval responsibility, clear inputs and outputs, and a stable ownership boundary.
- **Stage Output Contract**: The structured data passed from one major retrieval phase to the next so downstream stages can consume upstream decisions without depending on hidden side effects.
- **Retrieval Diagnostics Payload**: The result object that summarizes rewrite, candidate, rerank, and continuity decisions for callers and audit/reporting behavior.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Engineers can identify the owner of each major retrieval phase by inspecting the retrieval module structure and the orchestrator file without reading a single monolithic method body.
- **SC-002**: The top-level retrieval orchestrator no longer contains the full inline implementation of query interpretation, retrieval, scoring, prompt assembly, and diagnostics creation in one method.
- **SC-003**: Backend tests demonstrate that at least the major retrieval phases can be validated in focused units while preserving existing orchestrator-level behavior.
- **SC-004**: Existing callers of the retrieval pipeline continue to use the same entrypoint and receive the same retrieval result shape with no required API changes.
- **SC-005**: The final implementation introduces no new retrieval framework dependency and no unapproved schema or user-facing behavior changes.

## Assumptions

- The goal of this feature is internal maintainability and modularity, not end-user feature expansion.
- The current retrieval pipeline behavior is the source of truth unless the refactor requires a minor internal adjustment to preserve equivalent behavior through new seams.
- Not every micro-step needs to become an injected interface; small local transformations may remain pure helpers when that produces a clearer ownership model.
