# Feature Specification: Routine Dispatch Hardening & Non-Linear Flow (Jumps)

**Feature Branch**: `088-routine-dispatch-hardening-and-jumps` (work proceeds on the active branch)
**Created**: 2026-06-15
**Status**: Draft
**Depends on**: spec 087 (External Skills via MCP), merged in #720
**Input**: Four items deliberately deferred while 087 landed the external-skill spine. They land now that routine `skill` steps are live: (1) capability enforcement on the routine skill-dispatch path, (2) observability on that path, (3) removal of the retired routine "Outline" editor, (4) non-linear routine flow ("jumps") via the reserved step chip.

## Context

087 (#720) made routine `skill` (tool) steps live. The path today:

- `RoutineSkillExecutorDispatcher.dispatch` (`backend/src/modules/routines/skillDispatcher.ts:46-96`) resolves a skill name to a `SkillDefinition`, resolves its executor from the registry, dispatches, and projects the `SkillOutcome` onto a `RoutineSkillResult`. Every failure mode degrades to `unavailable(skillName, reason)` (a settled `failed` result) so the resumable state machine advances instead of throwing — the wedge-avoidance invariant documented at `skillDispatcher.ts:57-62`.
- `ExternalSkillRoutineSkillResolver.resolve` (`backend/src/modules/externalSkills/routineSkillResolver.ts:28-32`) always returns a generic external-skill `SkillDefinition` (`requiredCapabilities: []`, `execution: {kind:"internal", adapter:"external-skills"}`); per-agent existence/enabled gating lives in `McpSkillExecutor.findEnabledByName(agentId, skillName)`, which fails closed for non-authored names.

This dispatch path mirrors the chat retrieval-dispatch path (`SkillRetrievalTurnDispatch`, `backend/src/modules/chat/services/retrievalTurnDispatch.ts:91-154`) but is missing two things the chat path has — a workspace capability gate and observability — and the authoring surface has a reserved-but-inert `step` chip. The runtime already supports non-linear flow: the runner constrains a step to any *declared* successor (`packages/conversation-engine/src/routineRunner.ts:281-284`), bounds in-turn skill/action cycles with a hard `routine_walk_exceeded` backstop (`routineRunner.ts:419-427`), and bounds cross-turn loops with the `counter` guard over persisted per-step attempt counts (`routineRunner.ts:288-295,307-308`). Only the authoring surface and a loop-safety validator rule are missing.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Capability enforcement on routine skill steps (Priority: P1)

A workspace's capability policy (e.g. an EE plan or usage limit that denies external-tool invocation) must govern routine skill steps the same way it already governs chat retrieval. When a routine reaches a skill step whose required capability is denied for the workspace, the step must not invoke the external tool; the routine takes its failure path and the conversation degrades safely.

**Why this priority**: Without it, a routine bypasses the workspace capability gate that the chat path enforces — a security/authorization parity gap. It is the only item with a real authorization consequence.

**Independent Test**: With a `StrictCapabilityPolicy` denying the external-skill capability, a routine skill step returns a `failed` `RoutineSkillResult` (reason `capability_denied`) and the external executor is never invoked; with `DefaultAllowCapabilityPolicy`, the same step dispatches normally.

**Acceptance Scenarios**:

1. **Given** a workspace whose policy denies the external-skill capability, **When** a routine reaches a skill step, **Then** the external tool is not called and the routine follows its failure transition (the dispatcher returns `unavailable(skillName, "capability_denied")`).
2. **Given** a workspace whose policy allows the capability, **When** a routine reaches a skill step, **Then** the step dispatches exactly as today.
3. **Given** a skill whose definition declares no required capabilities, **When** the step runs, **Then** no policy call is made and it dispatches (parity with retrieval where no capability ⇒ no gate).
4. **Given** a capability denial, **When** the step resolves, **Then** the routine state machine is never thrown into (no 500, no wedge) — denial is a settled `failed` result, not an exception.

---

### User Story 2 — Observability on the routine skill-dispatch path (Priority: P1)

An operator debugging a routine turn must see a routine skill step in the trace and in metrics — distinguishable from a chat skill dispatch and from a raw external-tool call — with enough identity (routine, step, skill, outcome) to correlate a support report, and with no conversation content, params, secrets, or tool payloads.

**Why this priority**: 087 added an executor-level span (`external_skill.dispatch`) carrying tool identity, but the *dispatch path* itself — which sees the routine/step context and every failure mode that never reaches the executor (`unknown_skill`, `no_executor`, `capability_denied`) — emits nothing. A denied or unresolved step is currently invisible.

**Independent Test**: Dispatching a routine skill step records one `routine.skill.dispatch` span carrying routine id, step id, skill name, and terminal outcome status/reason on both the success and the `unavailable` paths; a dispatch metric is incremented by outcome; no blocked/PII attribute is present.

**Acceptance Scenarios**:

1. **Given** a routine skill step dispatches successfully, **When** the turn runs, **Then** a `routine.skill.dispatch` span is recorded with `routine.id`, `routine.step_id`, `skill.name`, and `outcome.status`, nested under the turn span.
2. **Given** a step fails for any reason (`unknown_skill` / `no_executor` / `deferred` / `capability_denied` / executor `failed`), **When** the turn runs, **Then** the span records that terminal status and reason and a dispatch metric is incremented labelled by outcome.
3. **Given** any dispatch, **When** attributes are recorded, **Then** no slot variables, collected params, tool outputs, answers, secrets, or tokens appear on the span or metric.

---

### User Story 3 — Remove the retired routine Outline editor (Priority: P2)

The routine "Outline" representation was retired in favour of the structured-prose editor (#717). Its dead modules remain in the tree and must be removed so they cannot be reintroduced or rot.

**Why this priority**: Pure cleanup, no runtime behavior. Independent of the other stories; can land first.

**Independent Test**: The outline modules are deleted, the existing e2e guard asserting the Outline tab is gone stays green (`frontend/tests/e2e/routines-settings.spec.ts`), and `pnpm run build`/`lint` are clean with zero dangling imports.

**Acceptance Scenarios**:

1. **Given** the prose editor is the routine authoring surface, **When** the outline modules are deleted, **Then** no production code imports them and the build/lint pass.
2. **Given** the live author-label field `outlineLabel` (step metadata), **When** cleanup runs, **Then** that field is **preserved** — it is not part of the retired representation.

---

### User Story 4 — Non-linear routine flow: jumps (Priority: P2)

A routine author can branch a step to **any** named step in the routine, not only the next one or a terminal — including looping back to an earlier step to retry or re-collect — using the reserved `step` chip in the prose editor. A loop (back-edge) must carry a bounding guard so it terminates.

**Why this priority**: The runtime already supports declared jumps and counter-bounded loops; this exposes the capability to authors. It is additive and independent of the dispatch-path stories.

**Independent Test**: An authored routine with a `step` chip targeting an earlier step round-trips prose ↔ draft ↔ compiled routine; the compiled transition's `to` equals the target step id; the runner follows the jump; a back-edge without a bounding guard is flagged by the validator; a jump to a non-existent step is flagged `dangling_step_reference`.

**Acceptance Scenarios**:

1. **Given** the prose editor, **When** an author inserts a `step` chip and selects an existing step, **Then** a branch targeting that step is authored and persists across save/reopen.
2. **Given** a `step` chip targets an earlier step (a loop), **When** the routine is validated, **Then** the author is required to attach a bounding guard (a `counter` guard, or another deterministic terminating guard) to that back-edge.
3. **Given** a `step` chip targets a step that no longer exists, **When** validated, **Then** a `dangling_step_reference` diagnostic is raised (existing rule, `validator.ts:118-124`).
4. **Given** a routine with a valid backward jump bounded by a counter, **When** it runs, **Then** the runner follows the jump and the loop terminates at the counter limit (`routineRunner.ts:307-308`).
5. **Given** the reserved terminal ids `done`/`handoff`, **When** authoring a `step` chip, **Then** they are never offered/selectable as jump targets (terminals are reached via the `end`/`handoff` chips, not a step jump).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Routine skill dispatch MUST evaluate the resolved skill's `requiredCapabilities` against the workspace `CapabilityPolicy` before invoking the executor, and on denial MUST return a settled `failed` `RoutineSkillResult` (reason `capability_denied`) without invoking the executor and without throwing.
- **FR-002**: External (MCP) routine skills MUST declare a required capability so that the workspace policy can gate them; OSS default policy (`DefaultAllowCapabilityPolicy`) MUST continue to allow them (no behavior change for OSS).
- **FR-003**: The capability gate MUST be supplied to the dispatcher by composition (closed over `workspaceId` at `forTurn` time); the conversation-engine and conversation-contract packages MUST NOT change (no `agentId`/`workspaceId`/policy threaded into the dispatch contract).
- **FR-004**: Routine skill dispatch MUST emit one OpenTelemetry span per step carrying routine id, step id, skill name, and terminal outcome status/reason, nested under the turn span, and MUST increment a dispatch metric labelled by outcome.
- **FR-005**: Observability output MUST NOT include slot variables, collected params, tool outputs, answers, prompts, secrets, or tokens.
- **FR-006**: The retired Outline modules MUST be deleted with no dangling imports; the live `outlineLabel` step-metadata field MUST be preserved.
- **FR-007**: The prose authoring surface MUST let an author target a branch at any existing step via the reserved `step` chip, round-tripping losslessly through prose ↔ draft ↔ compiled routine; reserved terminal ids MUST NOT be offered as jump targets.
- **FR-008**: The validator MUST require a bounding guard on any back-edge (a transition whose target is not strictly after its source in flow order), so a loop terminates; existing `dangling_step_reference` checks continue to cover jumps to unknown steps.

### Key Entities

- **`RoutineSkillExecutorDispatcher`** (`backend/src/modules/routines/skillDispatcher.ts`) — the routine skill-dispatch seam; gains the capability gate (FR-001/003) and observability (FR-004/005).
- **`externalSkillRoutineDefinition`** (`backend/src/modules/externalSkills/routineSkillResolver.ts`) — the generic external-skill `SkillDefinition`; gains the required capability (FR-002).
- **`CapabilityPolicy` / `capabilityNames`** (`backend/src/shared/domain/capabilityPolicy.ts`) — gains the external-skill capability name (FR-002).
- **Routine document / chip model** (`backend/src/modules/routines/document/model.ts`, `frontend/.../routine-chip-*`, `frontend/lib/routine-prose.ts`) — the `step` flow target + chip (FR-007).
- **Routine validator** (`backend/src/modules/routines/validator.ts`) — the back-edge bounding-guard rule (FR-008).

## Success Criteria *(mandatory)*

- **SC-001**: A workspace whose policy denies the external-skill capability cannot invoke any external tool from a routine; the routine follows its failure path. Demonstrated by a `StrictCapabilityPolicy` test (US1).
- **SC-002**: OSS behavior is unchanged: with the default allow-all policy, every routine skill step that worked after #720 still works.
- **SC-003**: An operator can see, for any routine turn, a per-step `routine.skill.dispatch` span and an outcome-labelled metric, with zero conversation content in observability output.
- **SC-004**: The Outline modules are gone; build, lint, and the existing prose/outline e2e guard pass.
- **SC-005**: An author can build a routine with a backward jump bounded by a counter, save/reopen it losslessly, and run it to completion; an unbounded back-edge is rejected at validation.
- **SC-006**: Engine and contract packages (`packages/conversation-engine`, `packages/conversation-contract`) are unmodified by this feature.

## Out of Scope

- Per-skill-definition capability lists (the gate is a single workspace capability for all external skills in v1).
- Async/deferred routine skill reconciliation (still degrades, per #720).
- A visual/canvas routine graph editor; jumps are authored in prose only.
- Changes to the external-skills connection/skill-definition model from 087.

## Implementation notes (as built)

- **Stable step ids (US4).** A step gains a stable id by being given a **title** in the prose editor: a `Step` toolbar button turns a line into an h1 heading whose text pins the id (a slug) and the author label (stored in the existing `step.metadata.outlineLabel` field, preserved from PR-1). Untitled lines keep their original positional `step_N` ids — the change is additive, so existing routines are unaffected. Only titled steps can be jump targets (a jump needs a stable name).
- **Authoring a jump.** A `Jump` toolbar button opens a dialog: pick the target titled step; for a backward jump (loop), tick "Loop back" and set a max count. A forward jump compiles to an AI-decided (`llm`) or condition (`field`) edge; a bounded backward jump compiles to a `counter` edge — the bound the FR-008 validator requires. No `"jump"` flow-target kind was added (a jump is a `step`-targeted branch the runtime already represents). h2 substeps are deferred to a follow-up.
- The prose ↔ draft ↔ compiled round-trip carries titled steps + jumps losslessly (unit-tested); the editor renders headings + `step` chips (with the loop bound on the chip face). A Playwright journey authors a counter-bounded backward jump end-to-end.
