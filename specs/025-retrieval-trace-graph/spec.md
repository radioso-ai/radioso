# Feature Specification: Retrieval Trace Graph

**Feature Branch**: `025-retrieval-trace-graph`  
**Created**: 2026-03-23  
**Status**: Draft  
**Input**: User description: "Expose chat history diagnostics as a graph showing retrieval steps such as rewrite, semantic and lexical retrieval, candidate preparation, reranking, prompt selection, and answer generation; include stage settings, fallback reasons, timings, and a RetrievalTrace payload for operator diagnostics."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Inspect One Answer Trace (Priority: P1)

An operator reviewing a specific chat answer wants to see the full retrieval path as a readable graph so they can understand which logical steps ran, which ones were skipped, and where quality degraded.

**Why this priority**: The core value of this feature is making one retrieval execution diagnosable without reading backend logs or mentally reconstructing the pipeline from partial counters.

**Independent Test**: Can be fully tested by executing a retrieval-backed chat request, opening its retrieval trace view, and verifying that the displayed graph matches the recorded execution path for that one answer.

**Acceptance Scenarios**:

1. **Given** a completed retrieval-backed chat answer, **When** an operator opens the retrieval trace view, **Then** the system shows the executed stages in logical order with branch points where multiple retrieval paths participated.
2. **Given** a retrieval execution that skipped or rejected one or more steps, **When** the operator views the trace, **Then** the graph shows those stages with explicit statuses and reasons instead of implying they ran successfully.
3. **Given** a retrieval execution that used fallback behavior, **When** the operator views the trace, **Then** the graph clearly identifies where fallback occurred and what effect it had on the remaining stages.

---

### User Story 2 - Drill Into Stage Decisions (Priority: P2)

An operator diagnosing poor citations or weak answers wants each stage in the graph to expose the settings, inputs, outputs, counts, timings, and reasons that shaped the final result.

**Why this priority**: A graph only becomes operationally useful when each node explains what happened and why, especially for rewrite behavior, candidate generation, filtering, reranking, and context trimming.

**Independent Test**: Can be fully tested by executing representative retrieval requests and verifying that each stage node exposes bounded diagnostics that explain the stage decision without requiring direct log access.

**Acceptance Scenarios**:

1. **Given** a stage in the retrieval trace, **When** an operator expands or selects that stage, **Then** the system shows its bounded inputs, outputs, settings, timing, metrics, and reason fields in readable product language.
2. **Given** a trace with multiple retrieval branches such as semantic and lexical candidate generation, **When** the operator inspects the branch nodes, **Then** the system shows branch-specific counts, statuses, and settings for each participating path.
3. **Given** a trace with no useful contexts or answer grounding, **When** the operator inspects the later stages, **Then** the system shows why final context selection and answer generation produced that outcome.

---

### User Story 3 - Review Historical Traces In Chat History (Priority: P3)

An operator reviewing a conversation over time wants historical answers in chat history to retain a retrieval trace so regressions or intermittent failures can be compared across turns.

**Why this priority**: Retrieval quality issues often depend on conversation context, so one isolated answer is not always enough to diagnose a recurring problem.

**Independent Test**: Can be fully tested by running a multi-turn conversation, reopening prior turns, and confirming that each stored answer exposes the corresponding retrieval trace or an explicit unavailable state.

**Acceptance Scenarios**:

1. **Given** a conversation with multiple retrieval-backed assistant answers, **When** an operator opens chat history, **Then** each eligible answer offers access to its recorded retrieval trace.
2. **Given** a historical answer whose trace is unavailable or intentionally omitted, **When** the operator opens its diagnostics view, **Then** the system explains that the detailed trace is unavailable instead of rendering a misleading empty graph.

### Edge Cases

- What happens when an execution includes only one retrieval path, such as lexical-only or semantic-only participation?
- What happens when a stage is eligible but skipped because an earlier decision made it unnecessary?
- How does the system present a stage that fails internally while the overall answer flow still degrades safely and returns a response?
- How does the system behave when no relevant contexts are found and downstream stages have little or no input?
- What happens when an operator opens a trace for an older answer created before detailed trace capture was enabled?
- How does the system avoid exposing sensitive raw document content, hidden prompts, or secrets while still remaining diagnostically useful?

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

- **Boundary Rule**: Chat routes and stream presenters remain transport-only, chat service remains orchestration-only, retrieval pipeline stages remain the source of retrieval execution facts, and dedicated presenter or assembly modules own shaping the operator-facing trace payload.
- **Encapsulation Rule**: The retrieval pipeline entrypoint and existing stage services MUST remain focused on retrieval behavior and MUST NOT absorb UI formatting concerns, while frontend chat-history surfaces MUST remain presentation-only and MUST NOT reconstruct hidden backend decisions client-side.
- **New Seams Required**: The feature MUST introduce explicit ownership for retrieval-trace assembly, retrieval-trace presentation to chat consumers, and graph-view state/rendering so diagnostics logic does not leak across unrelated layers.
- **Anti-Goals**: Do not convert retrieval diagnostics into a generic analytics platform, do not expose raw backend logs directly in the UI, do not require operators to inspect implementation-specific internals to understand the trace, and do not move retrieval decision logic into chat service or frontend components.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST capture a bounded per-answer `RetrievalTrace` for retrieval-backed chat executions so operators can inspect how the final answer context was produced.
- **FR-002**: `RetrievalTrace` MUST represent the logical execution path as ordered stages and branch nodes rather than only as aggregated counters.
- **FR-003**: The recorded trace MUST include, at minimum, stages covering conversation or request context preparation, query interpretation, candidate retrieval, candidate preparation, final context selection, prompt assembly, answer generation outcome, and final diagnostics.
- **FR-004**: When retrieval candidate generation uses multiple paths, the trace MUST distinguish those paths separately, including semantic retrieval based on the active query and lexical retrieval, and MUST show which paths participated for that answer.
- **FR-005**: The trace MUST record whether rewrite behavior was eligible, ran, was skipped, was rejected, or fell back, along with the effective query used for downstream retrieval and the continuity outcome for the turn.
- **FR-006**: The trace MUST record stage-level settings that materially affect retrieval behavior, including bounded retrieval and response settings relevant to the executed answer.
- **FR-007**: The trace MUST record stage-level inputs and outputs in a bounded form that is useful for diagnostics without exposing full raw prompts, sensitive document bodies, secrets, or unrestricted internal logs.
- **FR-008**: The trace MUST record stage-level metrics including counts and timing so operators can see where candidate sets changed and where latency accumulated.
- **FR-009**: The trace MUST record stage status using explicit outcome categories that distinguish successful execution from skipped, fallback, rejected, unavailable, or failed states.
- **FR-010**: The trace MUST record reasons for material branch, filtering, fallback, rejection, and trimming decisions when those reasons affect the final retrieval result.
- **FR-011**: The system MUST make the `RetrievalTrace` available through the operator-facing chat diagnostics flow for completed answers in both immediate answer inspection and historical chat review.
- **FR-012**: The operator-facing diagnostics experience MUST display retrieval execution as a readable graph that preserves stage order, branch participation, and final convergence into the selected answer context.
- **FR-013**: The graph view MUST allow operators to inspect detailed information for a selected stage without overwhelming the default overview.
- **FR-014**: The diagnostics experience MUST provide a raw trace view for operators who need exact recorded values rather than only summarized labels.
- **FR-015**: The system MUST continue to provide a compact retrieval summary for existing chat-answer surfaces even when the richer trace view is available.
- **FR-016**: Historical chat answers MUST expose their associated retrieval trace when one was recorded and MUST explicitly indicate when a detailed trace is unavailable.
- **FR-017**: The feature MUST degrade predictably when some stage facts are unavailable, preserving a coherent trace with explicit unavailable markers rather than dropping the entire diagnostic view.
- **FR-018**: The system MUST give each `RetrievalTrace` a stable identifier so the trace can be correlated with the corresponding answer and related audit or support workflows.
- **FR-019**: The operator-facing graph MUST remain a bounded diagnostic surface for one answer execution and MUST NOT require cross-conversation analytics, custom graph editing, or arbitrary querying in this feature.
- **FR-020**: `RetrievalTrace` MUST preserve enough structural information to reconstruct the execution graph deterministically, including stable trace identity, stable stage identity, stage ordering, and branch or convergence relationships between stages.

### UI Tasks

- The chat diagnostics experience must provide a retrieval-trace entry point for each eligible assistant answer.
- The retrieval-trace view must show a stage graph that operators can scan quickly before expanding details.
- The retrieval-trace view must let operators select a stage and inspect its status, settings, inputs, outputs, metrics, and reason text.
- The retrieval-trace view must distinguish skipped, fallback, rejected, unavailable, and successful stages in readable product language.
- The retrieval-trace view must provide access to a raw `RetrievalTrace` representation for support and debugging use.
- The chat-history experience must preserve access to retrieval traces for historical answers where traces were recorded.

### Key Entities *(include if feature involves data)*

- **RetrievalTrace**: The bounded diagnostic record for one retrieval-backed answer, containing trace identity, execution ordering, branch structure, stage diagnostics, and correlation to the produced answer.
- **RetrievalTraceStage**: One node in the recorded trace that represents a logical execution step or branch, including status, bounded settings, inputs, outputs, metrics, timing, and decision reason.
- **Retrieval Trace Graph View**: The operator-facing visualization that renders `RetrievalTrace` as a readable execution graph with stage drill-down and raw-trace access.
- **Retrieval Trace Detail Panel**: The operator-facing surface that presents the selected stage's bounded diagnostics in readable form.

## Assumptions

- The feature remains a per-answer diagnostic surface and does not introduce cross-answer analytics, aggregate dashboards, or configurable reporting.
- Existing compact retrieval information remains valuable for summary display and should coexist with the richer trace experience.
- Historical answers created before trace capture may not have full `RetrievalTrace` data, so the product must support a clear unavailable state.
- The retrieval graph should remain understandable without exposing full raw prompts, unrestricted internal logs, or complete document bodies.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In acceptance coverage for retrieval-backed answers, 100% of eligible completed answers expose either a `RetrievalTrace` or an explicit unavailable state in the operator diagnostics experience.
- **SC-002**: In trace-validation coverage, 100% of recorded traces include ordered stage records for the required logical stages and correctly identify skipped, fallback, rejected, or successful outcomes.
- **SC-003**: In diagnostic-view tests using representative retrieval scenarios, operators can identify the first stage where fallback, rejection, or empty-result behavior occurred within 30 seconds for at least 90% of test cases.
- **SC-004**: In bounded-data validation, 100% of trace payloads exclude prohibited sensitive content such as secrets, unrestricted raw backend logs, and full raw document bodies.
- **SC-005**: In historical-chat validation, 100% of eligible prior answers either render their recorded trace or display an explicit unavailable explanation without a broken or misleading graph state.
- **SC-006**: In regression coverage for the existing compact retrieval-information surface, 100% of previously supported retrieval summary fields remain available after the richer trace feature is introduced.
