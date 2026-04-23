# Feature Specification: Triggered Retrieval Filters

**Feature Branch**: `048-triggered-retrieval-filters`  
**Created**: 2026-04-23  
**Status**: Draft  
**Input**: User description: "Let workspace operators attach free-form trigger instructions to retrieval filters so those filters only enact when a query matches the intended situation; skip trigger analysis entirely when no triggerable filters exist; keep trigger decisions fully auditable in retrieval history, trace, and eval replay; support dynamic date comparisons such as today() for date-oriented filters; and improve the retrieval filter setup UI so common trigger/filter configurations are more convenient and understandable."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enact Filters Only When The Turn Warrants It (Priority: P1)

As a workspace operator, I want retrieval filters to activate only for queries that match their intended use so broad factual or definitional questions do not get hijacked by a narrow source class.

**Why this priority**: This is the core product problem. If retrieval filters still apply globally, the feature fails even if trigger authoring exists.

**Independent Test**: Can be fully tested by configuring at least one triggerable retrieval filter, running matched and non-matched queries, and verifying that the filter activates only for the intended turns while unmatched turns preserve broad retrieval.

**Acceptance Scenarios**:

1. **Given** a workspace configures an `event_filter` with a trigger instruction such as "Enact this filter when the user is clearly asking time-bound questions, e.g. upcoming courses, events, conferences", **When** the user asks "When is the next conference?", **Then** the system activates that filter for the turn and retrieval diagnostics show why it matched.
2. **Given** the same workspace and filter, **When** the user asks "What is mononuclear disease?", **Then** the filter does not activate and retrieval proceeds without event-specific narrowing.
3. **Given** multiple triggerable filters exist, **When** a query matches none of them, **Then** retrieval preserves baseline behavior and diagnostics explicitly record that no trigger-based filters were enacted rather than implying the step failed.

---

### User Story 2 - Skip Trigger Analysis When It Is Not Configured (Priority: P1)

As an operator running ordinary workspaces, I want the system to skip trigger matching entirely when no triggerable filters are configured so latency and cost do not increase for workspaces that do not use this feature.

**Why this priority**: The feature should not tax every chat turn globally when only some workspaces need scoped filters.

**Independent Test**: Can be fully tested by running retrieval-backed turns for a workspace with no triggerable filters configured and confirming that no trigger-matching execution runs and no extra diagnostic node appears as applied.

**Acceptance Scenarios**:

1. **Given** a workspace has no triggerable filters configured, **When** a retrieval-backed chat turn runs, **Then** the trigger-matching step is omitted for execution-cost purposes and diagnostics mark it as skipped because it was not configured.
2. **Given** a workspace has only always-on filters or boost rules with no triggers, **When** retrieval runs, **Then** existing non-triggered behavior continues without introducing a redundant trigger-analysis call.

---

### User Story 3 - Use Relative Date Semantics Without Constant Manual Edits (Priority: P2)

As a workspace operator authoring time-sensitive filters, I want to compare against a dynamic value like `today()` instead of a fixed date so event-oriented retrieval behavior stays current without repeated settings edits.

**Why this priority**: Date-based filtering becomes brittle and high-maintenance if operators must keep updating hard-coded dates just to preserve "upcoming" behavior.

**Independent Test**: Can be fully tested by configuring a date-oriented retrieval rule that compares against `today()`, running representative queries across different effective dates, and verifying that the rule evaluates relative to the current execution date rather than a stale saved literal.

**Acceptance Scenarios**:

1. **Given** a date-oriented retrieval filter uses a comparison against `today()`, **When** retrieval runs on a given day, **Then** the system evaluates the rule relative to that day instead of treating `today()` as a plain string.
2. **Given** an operator has configured an "upcoming events" style policy using `today()`, **When** time advances without any settings edits, **Then** the policy continues to target future-facing documents correctly.
3. **Given** a filter uses `today()` in a context where date comparison does not make sense, **When** the operator attempts to save or execute that policy, **Then** the system fails safely with clear validation or diagnostic feedback.

---

### User Story 4 - Inspect And Replay Why A Filter Matched (Priority: P2)

As an operator debugging a bad answer or comparing eval runs, I want to see exactly which triggerable filters were considered, which ones matched or did not match, and what evidence the system used so I can trust or revise the filter instructions.

**Why this priority**: A hidden classifier would create a new opaque failure mode. This feature only earns trust if operators can inspect and replay its decisions.

**Independent Test**: Can be fully tested by running a representative chat turn with configured triggerable filters, opening retrieval history/trace, and verifying that the trigger-analysis decision is visible there and preserved in eval replay diagnostics.

**Acceptance Scenarios**:

1. **Given** a turn matched one or more triggerable filters, **When** an operator inspects the retrieval trace or chat history diagnostics, **Then** they can see the candidate filters, the matched filters, confidence or match strength, and a bounded textual reason for each enacted filter.
2. **Given** a turn matched no filters, **When** an operator inspects diagnostics, **Then** they can see that the step ran, what it considered, and that no filter crossed the enactment threshold.
3. **Given** an eval dataset replays a case before and after a trigger-instruction or retrieval-policy change, **When** the operator compares runs, **Then** the eval diagnostics show whether the trigger-matching outcome changed and whether that changed retrieval behavior.

---

### User Story 5 - Configure Filters In A More Understandable UI (Priority: P3)

As a workspace operator, I want the retrieval filter setup UI to make common trigger and filter combinations easier to author and easier to understand so I can configure retrieval behavior without guessing at field semantics.

**Why this priority**: The backend feature will not be adopted or trusted if the settings UI remains hard to parse or too low-level for common use cases.

**Independent Test**: Can be fully tested by opening the retrieval settings screen, configuring common trigger/filter scenarios, and verifying that operators can understand when a filter applies, what it compares, and how date-relative values behave.

**Acceptance Scenarios**:

1. **Given** an operator is authoring a triggerable retrieval filter, **When** they use the settings UI, **Then** the interface clearly distinguishes always-on behavior from trigger-based behavior.
2. **Given** an operator is creating a date-oriented filter, **When** they choose a comparison value, **Then** the UI makes a dynamic option such as `today()` discoverable and understandable.
3. **Given** an operator reviews an existing retrieval policy, **When** they inspect it in the UI, **Then** they can understand in plain language what content it targets, when it activates, and whether it boosts, prefers, or hard-filters.

### Edge Cases

- A workspace configures no triggerable filters at all.
- A query partially matches multiple trigger instructions.
- A query mixes intents, such as a definition request plus a time-bound event request.
- A trigger instruction is poorly written, redundant, or too broad.
- Trigger matching says a filter should enact, but the resulting filtered retrieval produces weak or empty support.
- A workspace has both always-on policies and triggerable policies, and operators need to understand which behavior came from which source.
- A date comparison uses `today()` in an invalid operator or value-type combination.
- Trigger analysis is unavailable or returns malformed output, and retrieval must degrade safely.

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

- **Boundary Rule**: Retrieval settings routes and presenters remain the only transport owners of triggerable-filter and relative-date configuration; settings services remain orchestration-only for persistence; retrieval query analysis remains the owner of per-turn trigger matching; candidate-preparation or policy-application stages remain the owner of enacting matched policies and evaluating active date-relative comparisons; retrieval trace, chat history diagnostics, and eval replay remain the owners of presenting decision facts.
- **Encapsulation Rule**: [`backend/src/modules/retrieval/services/queryRewriteService.ts`](/Users/dm/conductor/workspaces/radioso/tripoli/backend/src/modules/retrieval/services/queryRewriteService.ts) and the query-interpretation stage may be extended to produce trigger-match decisions, but they MUST NOT absorb settings persistence or candidate-scoring logic; [`backend/src/modules/retrieval/services/metadataRuleScoringService.ts`](/Users/dm/conductor/workspaces/radioso/tripoli/backend/src/modules/retrieval/services/metadataRuleScoringService.ts) or its successor MUST consume already-decided active policies and MUST NOT become responsible for trigger prompt construction or settings parsing; the retrieval settings UI container MUST remain presentation-focused and MUST NOT own hidden policy-evaluation rules client-side.
- **New Seams Required**: The feature MUST introduce an explicit triggerable-filter configuration model, a focused query-analysis sub-result for trigger matches, additive retrieval diagnostics fields that preserve considered filters, matched filters, confidence or match strength, enactment reason, and fallback/backoff decisions, plus a bounded date-relative comparison model that can represent `today()` safely and readably.
- **Query-Analysis Placement Rule**: The first release MUST treat trigger matching as part of the existing query-interpretation phase rather than a new top-level retrieval pipeline stage, but it MUST surface as its own logical node in retrieval traces and eval diagnostics so operators can inspect it independently.
- **Execution Rule**: If no triggerable filters are configured for the workspace, the query-interpretation phase MUST skip trigger matching entirely instead of making a no-op model or embeddings call.
- **UI Review Rule**: The settings work MUST review and improve the existing retrieval-filter authoring experience for clarity and convenience rather than only bolting on one extra free-form field.
- **Anti-Goals**: Do not introduce a user-authored scripting language for trigger logic. Do not require a fixed product-defined intent enum for operator-authored triggers. Do not make embeddings-only similarity the authoritative enactment mechanism in the first release. Do not force every turn into a single-label intent choice when multiple or zero matches are more truthful. Do not hide trigger decisions inside unstructured prompt text with no durable diagnostics.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow a workspace to associate one or more retrieval policies or filters with an optional free-form trigger instruction that describes when the policy should enact for a user turn.
- **FR-002**: The system MUST preserve current retrieval behavior for workspaces that have no triggerable filters configured, including omitting trigger analysis for cost and latency purposes.
- **FR-003**: The system MUST evaluate triggerable filters during query interpretation for workspaces that have at least one configured trigger instruction and produce a structured per-turn trigger-match result before candidate policy application.
- **FR-004**: The trigger-match result MUST support `none`, one, or multiple matched filters rather than requiring exactly one winning label.
- **FR-005**: The trigger-match result MUST include, for each considered triggerable filter, a stable filter identifier, match outcome, bounded confidence or match-strength signal, and a bounded human-readable reason.
- **FR-006**: The system MUST use the structured trigger-match result to decide which retrieval policies enact for the current turn and MUST keep non-matched triggerable policies inactive.
- **FR-007**: The system MUST continue to support always-on retrieval policies that do not use trigger instructions, and diagnostics MUST distinguish always-on policy application from trigger-based application.
- **FR-008**: The first release MUST default trigger-based policy enactment to non-destructive behavior such as boost or preference unless an operator-configured policy is explicitly designated as hard filtering.
- **FR-009**: If a trigger-based hard filter or strong preference yields weak or empty grounded support, the system MUST support an explicit fallback or backoff path that can relax trigger-based narrowing and record that decision in diagnostics.
- **FR-010**: The system MUST fail safe when trigger analysis is unavailable, malformed, or below enactment confidence, preserving baseline retrieval rather than silently forcing a narrow filter.
- **FR-011**: The system MUST store and return triggerable-filter configuration through retrieval settings or the approved successor settings surface with additive compatibility for existing workspaces.
- **FR-012**: The system MUST keep trigger instructions free-form at the settings layer without requiring product code to enumerate every supported operator intent label.
- **FR-013**: The system MUST support a bounded dynamic date comparison token such as `today()` for date-oriented retrieval filters so operators can express relative present-day behavior without manually updating saved dates.
- **FR-014**: The system MUST evaluate `today()` and any approved relative-date token at execution time using explicit product-defined semantics rather than treating the token as raw prompt text or an opaque saved literal.
- **FR-015**: The system MUST validate that dynamic date tokens are used only in supported date-oriented contexts and fail safely when an operator attempts an unsupported combination.
- **FR-016**: The system MUST expose trigger-match execution facts through retrieval diagnostics, retrieval trace, chat history diagnostics, and eval replay artifacts.
- **FR-017**: The retrieval trace MUST present trigger matching as a distinct logical node or equivalent inspectable unit, even though execution occurs inside the broader query-interpretation stage.
- **FR-018**: Eval replay and regression comparison MUST preserve and compare trigger-match decisions, including matched filter IDs, non-match outcome, fallback/backoff behavior, and any changed confidence or reasoning summaries.
- **FR-019**: The first release MUST support an authoritative trigger-analysis mechanism that can evaluate a user query against free-form trigger instructions with bounded structured output.
- **FR-020**: If embeddings are used in this feature, they MUST be optional and limited to preselection or acceleration of candidate trigger instructions; embeddings similarity alone MUST NOT be the only authority that enacts a filter in the first release.
- **FR-021**: The system MUST keep trigger-analysis inputs and outputs bounded in diagnostics by recording the user query, bounded trigger instructions or IDs, structured decisions, and reasons, while excluding full raw prompts, unrestricted logs, or hidden chain-of-thought.
- **FR-022**: The retrieval settings UI MUST make the distinction between always-on filters, trigger-based filters, and date-relative comparisons understandable in plain operator language.
- **FR-023**: The retrieval settings UI MUST make common trigger/filter authoring tasks more convenient than the current experience, including discoverable trigger configuration, clear policy-behavior labels, and a readable way to select `today()` for supported date comparisons.
- **FR-024**: The system MUST provide automated coverage for no-config skip behavior, single-match activation, multi-match handling, false-positive avoidance on broad factual questions, `today()` evaluation, invalid date-token handling, fallback/backoff after weak filtered retrieval, UI save/reload behavior, and eval replay parity.
- **FR-025**: The system MUST preserve responsibility-limited module boundaries so settings persistence, query analysis, candidate policy enactment, date-relative evaluation, trace assembly, and eval comparison each remain owned by focused modules.

### UI Tasks

- The retrieval settings UI must let operators attach an optional free-form trigger instruction to a retrieval policy or filter.
- The settings UI must explain in plain operator language that trigger instructions decide when a policy applies for a turn rather than changing the corpus itself.
- The settings UI must review and improve the current filter-authoring flow so common configurations feel easier to set up and easier to understand.
- The settings UI must make dynamic date options such as `today()` discoverable and explain what they mean for upcoming or future-oriented filtering.
- The retrieval trace/history UI must show a dedicated trigger-matching diagnostic view with considered filters, matched filters, match strength, and reasons.
- Eval comparison surfaces must show when a case regressed because a trigger decision changed rather than only showing final answer differences.

### Key Entities *(include if feature involves data)*

- **Triggerable Retrieval Policy**: A retrieval policy or filter that includes an optional free-form instruction describing when it should enact for a turn.
- **Trigger Match Decision**: The structured per-turn output of query analysis that records which triggerable policies were considered, matched, rejected, or left inactive, along with confidence or strength and bounded reasons.
- **Dynamic Date Token**: A bounded operator-authored value such as `today()` that represents a relative execution-time date for supported comparisons.
- **Trigger Analysis Diagnostic Node**: The logical retrieval-trace and eval artifact that exposes trigger-match execution facts independently from the rest of query interpretation.
- **Policy Backoff Decision**: The recorded fallback event where a trigger-enacted narrowing policy is relaxed because it produced weak or empty grounded support.

## Assumptions

- Existing retrieval settings and signal-policy work provide the right persistence surface for storing trigger instructions and relative-date values additively instead of creating a separate settings family.
- Query interpretation is already the right architectural seam for per-turn semantic analysis, so trigger matching should live there rather than as a new top-level pipeline stage in the first release.
- A model-backed structured-completion path is the safest first authoritative mechanism for matching free-form trigger instructions because it can produce bounded reasons and uncertainty handling; embeddings may still help as an optional acceleration path later.
- Retrieval trace, chat history diagnostics, and eval replay already provide the right durable surfaces for operator-visible auditability, so this feature should extend them rather than inventing a separate analytics product.
- The UI should keep working within the existing admin design system while improving comprehension and convenience for common retrieval-policy authoring tasks.
- Operators will need to revise overly broad trigger instructions over time, so transparent diagnostics are a product requirement rather than a developer-only convenience.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In covered validation for workspaces with no triggerable filters configured, 100% of retrieval-backed turns skip trigger analysis without an extra trigger-match execution.
- **SC-002**: In representative validation scenarios, broad factual or definitional questions that do not match a configured trigger no longer enact narrow source filters that would have previously hijacked retrieval.
- **SC-003**: In representative matched scenarios, triggerable filters activate with inspectable reasons and produce the expected retrieval-policy enactment for at least one single-match and one multi-match case.
- **SC-004**: In validation of date-relative behavior, filters using `today()` continue to behave correctly across different execution dates without requiring settings edits.
- **SC-005**: In trace and history validation, 100% of trigger-analysis executions expose either a bounded trigger diagnostic record or an explicit skipped/unavailable state.
- **SC-006**: In eval replay comparison coverage, 100% of cases where trigger-match outcomes change between runs surface that change in per-case diagnostics.
- **SC-007**: In fallback validation, trigger-enacted narrow retrieval paths that produce weak or empty support can be identified and shown to have relaxed correctly instead of failing closed without explanation.
- **SC-008**: In operator validation of the settings flow, common trigger/filter setups can be configured and understood without relying on hidden implementation knowledge or trial-and-error guessing.
