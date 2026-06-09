# Implementation Plan: Routines as Data (082)

**Branch**: `data-driven-routines` | **Spec**: `specs/082-routines-as-data/spec.md`
**Design note**: `.context/routines-as-data-design.md`
**Depends on**: PR #664 (routine×directive co-composition + directive scope tags) merging before slices 4–6. Slices 1–3 are #664-independent.

## Summary

Make Routines **data a non-engineer authors** instead of a code const. An author writes a token-aware structured document (typed slots + numbered steps with variable/action/handoff tokens); a **compiler** translates it to the existing 069 `Routine` graph; the engine runs the compiled graph and the graph appears only in traces. Adds the definition data model, the compiler + validation, the authoring surface, and three 069 runtime extensions (typed slots, fast-forward traversal, condition-gated action references + handoff). Export/import is deferred. Contact flow becomes the pilot authored definition.

## Resolved Design Decisions

Two spec-open items, resolved here (both reuse existing patterns rather than invent):

- **Activation arbitration (multi-routine).** Each `routine_definition` carries an author-set integer `activation_priority`. The engine evaluates declared triggers; among matched routines, **highest priority wins, deterministic tiebreak by `(created_at, id)`**. One routine activates per turn (v1 assumption unchanged). This mirrors the directive priority+index resolution #664 introduced in `DefaultSteeringResolver` — same mental model, no new concept.
  - **Clarification deferred (Option B).** v1 is silent arbitration only; "ask the user when candidates are too close" — our **Clarification** capability (a.k.a. disambiguation in the literature) — is a separate cross-cutting feature (`.context/clarification-generic.md`, future spec — also serves retrieval-sense ambiguity, not just routines). Distinct from slot-filling (which collects a missing value). **Seam to preserve now:** when multi-routine activation is built, the matcher MUST return a **ranked candidate set and pick the top**, not short-circuit on the first matching trigger — so the Clarifier can later intercept the "top candidates within margin" case with no rework. No v1 behavior change.
- **Action-permission model (net-new gate).** Reuse the existing `CapabilityPolicy` mechanism (today gating skills via `requiredCapabilities`). An **action registry** declares, per action `type`, the capability/ies required to invoke it (e.g. `contact.send` → `human_contact.request`). Two enforcement points: **publish-time** (a definition referencing an action the agent isn't permitted to invoke is rejected, per the spec edge case) and **enqueue-time** in `chatTurnLifecycle` (defense in depth, analogous to `firstDeniedCapability` for skills). No per-action bespoke policy — action type → required capability → `CapabilityPolicy.can`.

## Constitution Check

- **Spec-First**: spec approved 2026-06-09. ✅
- **Backend TDD**: every backend slice writes failing tests first (table round-trip, compiler→graph, each validation failure class, fast-forward traversal, condition-gated action + counter guard, permission gate publish+enqueue, version pinning, scope-tag orphan). ✅
- **Stack**: Node/React/Postgres+pgvector; compiler's parse pass + next-step selection LLM via central `resolveLlmConfig` (GPT-5.2 default). ✅
- **No keyword lists**: activation, progression, and the compiler's NL parse use LLM structured output / typed schemas / settings — never English regex. Authoring-token grammar parsing is structural format parsing, allowed. ✅
- **Engine purity / boundaries**: the **compiler lives backend-side**; the **engine consumes the compiled 069 `Routine` only** and never the authoring document. Engine MUST NOT import authoring/definition/product modules; dep-cruiser `engine-concretes-only-via-composition` (added by #664) is the guard. ✅
- **Composition ownership**: the `RoutineRegistry` is fed from **DB-backed compiled published definitions** (replacing the code-registered const), and the action registry (with `requiredCapabilities`) is assembled in `backend/src/app/composition/`. Domain rules (compiler, validation) stay in modules. ✅
- **Code-First OpenAPI**: routine-definition CRUD/validate/publish routes defined in the OpenAPI registry with Zod; `openapi.yaml/json` regenerated; `test:contract` green; SDK/MCP generated types refreshed. ✅
- **Message-Queue/Contract review**: `Routine`/`RoutineStep` (in `conversation-contract`) is extended (typed slots, action-reference gating, handoff terminal) and is consumed by engine + kit — see Impact Review. The action outbox already exists (069); no new AMQP payload. ✅
- **Docs Parity**: authoring-as-data, compile/validation, fast-forward, condition-gated actions, handoff, versioning. ✅
- **Frontend testing**: token-aware editor covered by Playwright; unit tests only for the token model + draft-validation adapter. ✅

## Slices (each independently testable; TDD; dependency-ordered)

Slices 1–3 ship on the already-merged 069 runtime and do **not** need #664. Slices 4–6 are sequenced after #664.

### Slice 1 — Routine definition as agent data + compiler + validation (P1 / US1)
- **Migrations (start at `083`)**: `routine_definition` (id, agent_id FK ON DELETE CASCADE, version, name, status `draft|published`, activation_trigger_description, activation_gate_ref, activation_priority, created_at, updated_at; `UNIQUE(agent_id, name, version)`) + child tables `routine_slot` (definition_id FK, key, type, required, description, ordinal), `routine_step` (definition_id FK, stable_step_id, kind `chat|tool|fork`, instruction, tool_ref, ordinal, metadata), `routine_transition` (definition_id FK, from_step, to_ref, guard_kind, guard_text, ordinal), `routine_terminal` (definition_id FK, stable_step_id, kind `complete|handoff|action`, action_type). Stable ids on steps/slots.
- **Domain**: `RoutineDefinition` type + Zod authoring schema; `compileRoutineDefinition(def): Routine` producing the 069 contract graph + slot schema, **deterministically** (same doc → same ids); validator producing **author-facing** diagnostics (unreachable step, missing terminal, dangling action/variable reference, undeclared-but-referenced / declared-but-unused slot, attempt-limit-without-fallback, over-permission action via the action registry).
- **Repository**: load (one lateral `json_agg` per child set, like `agent_directives`), create/update draft, publish (snapshots a version).
- **Composition**: `RoutineRegistry` populated from compiled **published** definitions per agent (the DB-backed routine source replacing the const path).
- **Tests**: child-table round-trip; compile→valid 069 graph; compiler determinism; each validation failure class rejected in author terms; an authored 2-slot/2-step routine activates + completes on the existing 069 runtime with zero engine routine-identity branches.

### Slice 2 — Typed slots + fast-forward traversal (P1 / US2)
- **Contract/engine**: generalize routine variables from `Record<string, unknown>` to a declared typed **slot schema**; extraction targets declared slots; "filled" is per-slot well-defined. Generalize the routine runner / next-step selector to **fast-forward**: within one turn advance through every step whose preconditions are already satisfied by pre-provided slots, steering from the first step still needing input/action.
- **Fast-forward mechanism (decided)**: structured guards stay in Slice 3. v1 fast-forward = **one extraction pass** (the selector extracts every declared slot present in the user message, not just the current step's) + a **bounded loop over a pure typed-slot check**: after the selector lands on a chat step, if that step's collected slot(s) (compiled into step metadata from its `{{slot.x}}` references) are already present in state, re-invoke the selector to advance again; stop at the first chat step with an unfilled required slot (render it) or a tool/terminal step (existing handling). Loop bounded by step count. LLM cost ≈ extraction + final render regardless of how many slots were pre-provided. The fast-forward loop MUST preserve #664's `steeringResolver` on the final render.
- **Tests**: one message providing N facts advances past all N satisfied steps in that turn (no intermediate prompt); partial provision asks only for the missing slot; typed-slot extraction/validation; **existing contact-flow / routine runtime tests still pass (parity)**.

### Slice 3 — Condition-gated actions + outcome branches + structured guards + handoff + permission gate (P1 / US3)
- **Contract/engine**: condition-gating on a step's action reference (availability gated; engine decides invocation); outcome edges; **structured guards** (slot-filled / action-outcome / counter) for bounded retries — never LLM counting; **handoff** as a first-class terminal kind, recorded distinguishably in the trace.
- **Action-permission gate (net-new)**: action registry carries `requiredCapabilities` per action type; publish-time validation (Slice-1 validator calls it) + enqueue-time check in `chatTurnLifecycle` (analogous to skills' `firstDeniedCapability`).
- **Tests**: success / not-found→retry / two-fail→handoff paths; counter guard enforces the limit (structured, not LLM); engine (not routine) decides the call; permission gate rejects an unauthorized action at publish and at enqueue.

### Slice 4 — Versioning + stable identity + in-flight pinning + scope-tag orphan protection (P2 / US4) — *needs #664*
- `routine_state` pins the **definition version** it started on; explicit **migrate-vs-finish** policy for in-flight sessions on republish; recompile **preserves stable step ids**; **orphaned directive scope tags** (`step:<routineId>:<stepId>`, per #664) detected and surfaced on edit (the orphan-observability follow-up #664 defers).
- **Tests**: in-flight conversation continues on its pinned version after republish; new conversation gets the new version; edit preserves step ids so a step-scoped directive does not orphan; removing a scoped step surfaces the orphan rather than dropping it.

### Slice 5 — Authoring UI: token-aware structured editor (P1/P3 UX) — *needs Slices 1–3 APIs*
- Step blocks (numbered, prose body) + insertable **variable / action / handoff chips** + guideline references; validation surfaced **in author terms**; no canvas.
- Playwright journey (author → validate → publish → run); unit tests only for the token model + draft-validation adapter.

### Slice 6 — Contact pilot (P2) — *needs Slices 1–3*
- Re-express `contactRoutine` as an **authored data** definition; retire the code const + its composition registration; verify behavior parity (prompts, submitted contact row, idempotency, receipt). Contact needs neither directives nor scope, so #664 is not strictly required for this slice.

### Deferred (post-v1)
- **Export/import + reference re-binding** (US5/FR-012), gated on the shared 079 import/re-binding mechanism.

## Impact Review (message-queue / cross-service contracts)

- `Routine`/`RoutineStep`/`RoutineTransition`/`RoutineState` (in `packages/conversation-contract`) are **extended**: typed slot schema, condition-gated action reference + outcome edges, structured guards, handoff terminal kind. Consumed by the engine (`ProcessTurnInput`) and the kit — restate in the PR; keep extensions additive/back-compatible with #664's shapes.
- **New HTTP**: routine-definition CRUD / validate / publish routes — code-first OpenAPI registry, regenerate `openapi.yaml/json`, contract tests, refresh SDK + MCP generated types.
- **No new worker/AMQP payload**: the action outbox + `ActionHandlerRegistry` already exist (069); this feature only adds a **capability requirement** to action types, checked synchronously. Restate "no queue contract change" in the PR.
- **Migration numbering**: #664 takes `082_agent_directive_scope_tags.sql`; 082's migrations start at `083`.

## Module Ownership & Seams

- **Transport**: new routine-definition routes (`backend/src/app/http/...`, OpenAPI registry) — translate/validate only.
- **Orchestration**: `RoutineDefinitionService` (CRUD/publish) + a `RoutineCompilerService` boundary — coordinate, delegate domain decisions.
- **Domain**: the **compiler** + **validator** + `RoutineDefinition` types (new `modules/routines`, or under `modules/agents` if ownership is cleaner) — own the authoring→graph rules. The engine extensions (typed slots, fast-forward, action-gating, handoff) live in `conversation-engine`/`conversation-contract`, narrow and product-independent.
- **Persistence**: `routineDefinitionRepository` + child tables; `routine_state` version pinning.
- **Application Composition**: wire the DB-backed `RoutineRegistry` source (compiled published definitions), the action registry with `requiredCapabilities`, and the enqueue-time permission gate — in `backend/src/app/composition/`.
- **Files Kept Small**: do not bloat `ChatService` / `routineRunner` / `chatTurnLifecycle`; the compiler, validator, and permission gate are their own modules.
- **Planned Extractions**: `RoutineCompiler`, `RoutineValidator`, `ActionRegistry` (typed action → required capabilities), DB-backed `RoutineSource` feeding `RoutineRegistry`.
- **Required Refactor Stories**: the `RoutineRegistry` must accept a runtime/DB source rather than only composition-time consts — land this seam in Slice 1 before the pilot retires the const in Slice 6.

## Docs

Operator-facing authoring guide (token editor, slots, actions, handoff, validation), API doc for the routine-definition routes, and the `modules/routines` local README. Extend `docs/architecture/assistant-turn-spine.md` for the compile→graph path. Follow `docs/document-writer-prompt.md`.

## Verification

- **Per-slice**: focused unit/contract/engine tests green; `tsc` clean; independent verification by the orchestrator (run the slice tests directly + read the diff against `origin/main`), never self-reported.
- **Pre-PR**: `pnpm run ci:local -- origin/main` (`--all` given breadth), result in PR body. Re-run the known shared-DB flakes before blaming the diff.
- **Sequencing gate**: confirm #664 is merged into the branch base before starting Slices 4–6.
