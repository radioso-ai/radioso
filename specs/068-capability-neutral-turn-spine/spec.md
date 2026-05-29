# Feature Specification: Capability-Neutral Turn Spine

**Feature Branch**: `068-capability-neutral-turn-spine`
**Created**: 2026-05-29
**Status**: Draft
**Input**: Completes 066 **User Story 1 / SC-001** (issue #465), deferred when 066 shipped retrieval-as-a-dispatched-skill (US2/SC-002). Unblocks 067 slices 3–4.

**Scope Note**: This spec makes the assistant turn **capability-neutral**: one loop that **selects** which skill(s) a turn needs, **dispatches** them, and **composes** a reply from a **generic staged context** — with retrieval as one source among many, not a privileged shape. Concretely it (a) introduces a per-agent **skill-selection strategy** that unifies the two parallel paths the turn has today (skill-intake vs. grounded-answer), and (b) generalizes the **compose** step to read a generic turn-outcome set rather than a `RetrievalPipelineResult`. Once this lands, skill-emitted `SkillOutcome.guidance` flows into the steering set (067 slice 3) and matched Directives can bias selection (067 slice 4).

This spec keeps **resolution (b)** from 066 — capabilities produce *staged context/data*, the loop composes — and does **not** move answer composition into skills, build an async/deferred engine, add new persistence, or change the headless `retrieval.*` surfaces. Those are anti-goals.

**Validated against Parlant** (`~/code/parlant`): its `engines/alpha/prompt_builder.py` composes message generation from one unified context assembled from heterogeneous sections — tool *results* (`add_staged_tool_events`), matched guidelines, context variables, glossary, history — with a single generator and no per-capability composer. Parlant's tools produce staged *data*, not pre-composed answers. That is exactly resolution (b) plus a generic compose; this spec adopts that shape.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Add A Non-Retrieval Skill With No Retrieval-Shaped Path (Priority: P1)

As a developer extending the assistant, I want to add a synchronous non-retrieval skill (e.g. order-status) by registering its catalog entry and executor, and have the turn select, dispatch, and render it **without** going through any retrieval-shaped code path.

**Why this priority**: This is SC-001 — the architectural reason 066 existed. Today a turn either runs skill-intake or the retrieval/grounded path; a new capability that is neither still has no first-class route, and the grounded compose is typed to `RetrievalPipelineResult`.

**Independent Test**: Register a throwaway non-retrieval skill whose executor returns a `settled` `SkillOutcome` with an `answer`. Submit a turn the selection strategy routes to it. Assert (a) the turn dispatched that skill, (b) its outcome was rendered into the response by the **generic** compose path, and (c) no file under `backend/src/modules/retrieval/` was imported or modified to make it work, and the chat turn loop gained no skill-specific branch.

**Acceptance Scenarios**:

1. **Given** a registered non-retrieval skill the strategy selects, **When** the turn runs, **Then** the loop dispatches it and composes the reply from its `SkillOutcome` (answer/outputs), with the dispatch recorded in the activity trace.
2. **Given** the chat turn, **When** its structure is inspected, **Then** selection and compose are driven by the generic outcome/strategy, not by an `if (intake) … else retrieve` branch hard-coded in `ChatService`.

---

### User Story 2 - Grounded Answering Is Preserved Exactly (Priority: P1)

As a maintainer, I want the existing grounded-answer behavior (answer text, citations, suggestions, grounded-miss fallback, streaming, activity trace, eval snapshot fields) to be **byte-for-byte preserved** when retrieval is the selected skill.

**Why this priority**: The generic compose must not regress the most important and most specialized path. Retrieval composition (citations, envelope, streaming) is richer than a generic skill render; it must remain intact, reached as one renderer of the generic outcome.

**Independent Test**: For a fixed set of grounded-answer conversations, post-spine answers, citations, suggestions, and traces match pre-spine output (regression parity), with the trace showing retrieval dispatched as a selected skill.

**Acceptance Scenarios**:

1. **Given** grounded answering enabled, **When** a retrieval turn runs, **Then** the produced answer/citations/suggestions/trace match pre-spine output for the same query and corpus.
2. **Given** a streamed grounded answer, **When** the turn runs, **Then** streaming behavior and the grounded-miss fallback are unchanged.

---

### User Story 3 - Selection Is A Per-Agent Strategy, Biasable By Directives (Priority: P1)

As an architect, I want which skill(s) a turn dispatches to be decided by a **per-agent selection strategy resolved at composition**, taking matched Directives as soft signals, so that the loop holds the mechanism and behavior is replaceable per agent.

**Why this priority**: This is the seam 067 slice 4 plugs into. Selection must be a strategy, not branches in `ChatService`, and Directives must be able to influence it without the loop knowing any specific skill.

**Independent Test**: A matched Directive that prefers a skill changes selection for an otherwise-ambiguous turn; the selector records that the directive signal was considered. With no directives, selection is unchanged from the default.

**Acceptance Scenarios**:

1. **Given** a default selection strategy, **When** a turn matches a skill's intent, **Then** the strategy selects it; when nothing matches, the turn produces the agent's default conversational response.
2. **Given** a matched Directive biasing selection, **When** the strategy runs, **Then** the directive is a soft signal (the structured decision is authoritative) and the consideration is recorded.

---

### Edge Cases

- No skill selected → the loop produces the agent's default (direct/social) response, not an error.
- Selected skill executor throws or returns non-`completed` → recorded failure outcome; the turn still produces a response (degraded), and the failure is distinguishable in the trace from a retrieval-pipeline failure.
- Multiple skills could match → the strategy defines ordering/selection; single-skill-per-turn is acceptable for v1 as a strategy policy, not a loop limitation.
- Capability denied for the selected skill → not dispatched (reported forbidden); the turn degrades (for retrieval, to a non-grounded answer, as 066 already does).
- A non-retrieval skill outcome with no `answer` but with `outputs` → the generic composer renders through the LLM/canned path; it never emits hard-coded conversational copy.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be Node.js/TypeScript; database PostgreSQL + `pgvector`. No new storage; no persisted selection/outcome records in v1.
- Backend development MUST follow TDD: regression-parity tests for grounded answering written/passing before and after the re-seam; new tests for the generic compose and the selection strategy.
- Customer data MUST be least-privilege: selection and dispatch MUST honor the per-agent capability model (a skill the agent is not authorized for is not selected/dispatched).
- Modular boundaries MUST hold: the chat module owns the loop (gather→select→dispatch→compose) and MUST NOT own a skill's business logic, retrieval strategy, or provider details. The generic compose MUST NOT branch on specific skill names.
- Composition owns replaceable wiring: the per-agent selection strategy and the outcome renderers MUST be assembled under `backend/src/app/composition/`.
- Runtime prompts live under `backend/prompts/`. Selection MUST NOT be an English keyword list/regex — it is an LLM-returned structured decision or a settings/strategy rule. User-facing copy stays LLM/canned-owned.
- Public/SDK/MCP/worker contract changes MUST include a message-queue review. v1 changes no public contract; the headless `retrieval.*` surfaces are untouched.
- Documentation MUST describe the capability-neutral loop, the selection strategy, and the generic compose (extending `docs/architecture/assistant-turn-spine.md`).

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The chat module owns the turn loop. It gathers context, asks the **selection strategy** which skill(s) to dispatch, dispatches them through the skill-invocation port, and composes the reply from the resulting **turn outcome**. It MUST NOT branch on specific skills or own a skill's logic.
- **Generic-Staged-Context Rule (the keystone)**: The compose step MUST read a **generic turn outcome** — the dispatched skill(s)' `SkillOutcome`(s) plus the steering set — not a `RetrievalPipelineResult`. Retrieval's rich result is one *kind* of staged context, carried on the outcome and consumed by a **retrieval renderer**; a non-retrieval outcome is rendered by the **generic renderer**. Renderers are selected by outcome *kind/capability*, registered at composition — never by `if`-chains in the loop. This keeps resolution (b): capabilities stage data, the loop composes.
- **Selection-As-Strategy Rule**: Which skill(s) a turn dispatches MUST be a per-agent strategy resolved at composition, consuming the gathered context and matched Directives as soft signals. It supersedes the hard-coded skill-intake-vs-grounded branch in `ChatService`. v1 MAY ship one default strategy and single-skill-per-turn.
- **Parity Rule**: The retrieval renderer MUST reproduce today's grounded-answer composition exactly (citations, suggestions, grounded-miss, streaming, eval-snapshot fields). Generalization MUST be extraction, not rewrite, for the retrieval path.
- **Dependency Direction Rule**: `chat → skills (port + catalog + selection)`, `chat → directives (matcher)`. Chat MAY depend on the retrieval *result type* (as today) but MUST NOT call retrieval pipeline methods directly; retrieval is reached only through dispatch.
- **Source-Of-Truth Rule**: The session/conversation event stream remains the record of a turn's observable output. The turn outcome is assembled per turn and not persisted as a separate entity in v1.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The chat turn MUST be one loop — gather → select → dispatch → compose — replacing the current parallel skill-intake and grounded-answer code paths in `ChatService.answer`/`streamAnswer`.
- **FR-002**: A per-agent **selection strategy** MUST decide which skill(s) a turn dispatches, consuming gathered context and matched Directives as soft signals. v1 MAY ship a single default strategy preserving today's behavior (intake skill if its intent matches; else retrieval if enabled; else direct).
- **FR-003**: The compose step MUST consume a **generic turn outcome** (dispatched `SkillOutcome`(s) + steering set), not a `RetrievalPipelineResult`. The retrieval result rides on the outcome (as 066 already does via `metadata`) and is rendered by a retrieval renderer.
- **FR-004**: Outcome rendering MUST be dispatched by outcome kind/capability through renderers registered at composition. The chat loop MUST contain no skill-specific branches. Adding a non-retrieval skill MUST require only a catalog entry + executor (+ a generic-renderable outcome), with zero changes under `backend/src/modules/retrieval/`.
- **FR-005**: Grounded answering MUST be preserved byte-for-byte for the retrieval case (answer, citations, suggestions, grounded-miss, streaming, activity trace, eval-snapshot fields) — verified by regression-parity tests.
- **FR-006**: Selection and dispatch MUST honor the per-agent capability model; an unauthorized skill is not selected/dispatched and the turn degrades gracefully.
- **FR-007**: A selected skill that throws or returns a non-`completed` outcome MUST be recorded as a distinguishable failure in the trace; the turn still produces a response.
- **FR-008**: Skill-emitted `SkillOutcome.guidance` from the dispatched skill MUST be merged into the turn's steering set the composer reads (067 slice 3 lands on this seam).
- **FR-009**: Selection MUST NOT be an English keyword list/regex; it is an LLM-returned structured decision or a settings/strategy rule. Any selection prompt lives under `backend/prompts/`.
- **FR-010**: Documentation MUST describe the loop, the selection strategy, the generic compose, and the renderer registry.

### Key Entities *(include if feature involves data)*

- **Selection Strategy (per-agent)** — resolved at composition; maps gathered context + matched Directives to the skill(s) to dispatch. No persisted entity in v1. New.
- **Turn Outcome** — the generic per-turn result the composer reads: the dispatched `SkillOutcome`(s) + the merged steering set. New; supersedes the implicit "either intakeResult or session.retrieval" branch.
- **Outcome Renderer** — composes the response from a turn outcome; selected by outcome kind/capability. The **retrieval renderer** wraps today's grounded composition; the **generic renderer** renders `answer`/`outputs` through the LLM/canned path. Registered at composition. New.
- **SkillOutcome / SteeringRule** — existing (066/067); unchanged shapes, now the generic currency the loop composes from.

## Data Model Direction

No new tables, no new persistence. The selection strategy and renderers are composition-resolved code, like the default skill catalog and the 066 orchestration wiring. The conversation/message event stream remains the source of truth for turn output.

## API Direction

No new public REST endpoints; assistant chat request/response and streaming surfaces are preserved. Internal types (the turn outcome, selection strategy port, renderer registry) are not public API but MUST be reflected in any exported skill/chat contract types and reviewed against the OpenAPI registry. The headless `retrieval.*` surfaces are unchanged.

## Delivery Split

Each slice independently shippable and parity-preserving where possible:

1. **Generic turn outcome + renderer registry (retrieval renderer = extraction).** Introduce the turn-outcome type and a renderer keyed by outcome kind; move today's grounded composition into a retrieval renderer with **zero behavior change**. Compose reads the outcome, not `session.retrieval` directly.
2. **Generic renderer + non-retrieval skill path.** Render a `SkillOutcome.answer`/`outputs` through the LLM/canned path; prove with a throwaway non-retrieval skill (US1 test).
3. **Selection strategy.** Replace the hard-coded intake-vs-grounded branch with a per-agent strategy (default preserves behavior); unify the two paths into one loop.
4. **Convergence with 067.** Merge dispatched-skill `guidance` into the steering set (067 slice 3); feed matched Directives into the selector (067 slice 4). Docs.

## Assumptions

- 066 (retrieval as a dispatched skill; `RetrievalTurnPort`) and 067 slices 1–2/5 (directives + steering set) are merged.
- A single default selection strategy and single-skill-per-turn are acceptable for v1; multi-skill/parallel must remain expressible by the port, not necessarily implemented.
- The existing chat stream channel and activity trace are sufficient; no new transport.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A non-retrieval skill can be made available to the assistant with a catalog entry + executor registration and **zero** changes under `backend/src/modules/retrieval/` and **zero** skill-specific branches in the chat turn loop (verified by diff inspection in the User Story 1 test).
- **SC-002**: For a fixed set of grounded-answer conversations, post-spine answers, citations, suggestions, and traces match pre-spine output (regression parity), with retrieval shown as a selected/dispatched skill.
- **SC-003**: The compose step reads a generic turn outcome; no `RetrievalPipelineResult`-typed parameter and no skill-name branch exists in the loop or the generic renderer (verified by inspection).
- **SC-004**: Skill selection contains no English keyword lists/regexes (verified against the no-keyword-lists rule).
- **SC-005**: A dispatched skill's `guidance` reaches the composer's steering set, and a matched Directive biases selection (the seams 067 slices 3–4 require), verified by focused tests.
- **SC-006**: Docs describe the capability-neutral loop, selection strategy, generic compose, and renderer registry.
