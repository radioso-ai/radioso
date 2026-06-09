# Slice 3a Notes: Structured Guards, Counter, Handoff

## Independent verification (orchestrator, 2026-06-09)

- **Determinism (the core requirement)**: confirmed in code — `selectNext` evaluates structured guards (`slot_filled`/`outcome`/`counter`) in `guardMatches` and returns the matched edge **before** any selector call; the selector runs only when an `llm` edge exists and no structured guard matched. Asserted in tests ("branches on structured outcome guards without consulting the selector"; `select` call-count checks). Counter→handoff routes via `attempts[stepId] >= limit` — no LLM counting.
- **Parity by construction**: routines with only `llm`/`condition` edges (incl. `contactRoutine`) match no structured guard → fall to the selector → unchanged. Contract change additive (`RoutineTransition.guard?`, `RoutineState.attempts?` optional); new migration `084` (083 untouched).
- **Caught + fixed a gap Codex missed**: Slice 3a added guard authoring fields (`counterLimit`, etc.) to the backend OpenAPI but the **SDK/MCP generated artifacts were not resynced** → `sdk-openapi.contract.test.ts` failed (2). Resynced SDK + MCP; `check-api-contracts` current.
- **Full verification**: engine package 60, defaults 26; backend `tsc` clean; **full `vitest run tests/unit tests/contract` → 1841 pass (0 fail)**; `lint:boundaries` clean (556 modules).

## Contract Changes

- `RoutineTransition.guard` is optional and additive. Legacy transitions still use `condition` with no guard.
- Structured guards:
  - `{ kind: "slot_filled"; slots: string[] }`
  - `{ kind: "outcome"; status: RoutineSkillOutcomeStatus }`
  - `{ kind: "counter"; limit: number }`
  - `{ kind: "fallback" }`
  - `{ kind: "llm" }` for explicit legacy selector edges.
- `RoutineSkillOutcomeStatus` is routine-local: it accepts the existing skill statuses plus action/tool-specific strings such as `found` and `not_found` without widening backend chat skill status enums.
- `RoutineState.attempts?: Record<string, number>` stores per-step entry counts. The runner increments the count when a step is entered and persists it with routine state.
- `ConversationRoutineResumeResult.terminal` and `ProcessTurnResult.handoff` distinguish handoff exits from normal completion.

## Compiler And Migration

- `routineGuardKinds` now includes `slot_filled`, `outcome`, and `counter`, in addition to `llm`, `always`, and `fallback`.
- The compiler emits structured `guard` objects:
  - `slot_filled` slots are derived from `{{slot.x}}` references in `guardText`.
  - `outcome` reads `outcomeStatus` first, then `guardText`.
  - `counter` reads `counterLimit` first, then a numeric `guardText`.
  - `fallback` emits `{ kind: "fallback" }`.
- `llm` and `always` remain condition-only selector edges for backward compatibility.
- Migration `084_structured_routine_guards.sql` adds:
  - `routine_states.attempts JSONB NOT NULL DEFAULT '{}'`
  - `routine_transition.outcome_status`
  - `routine_transition.counter_limit`
  - an updated `guard_kind` check for the structured guard kinds.

## Validator

- `outcome` guards are valid only on transitions leaving authored `tool` steps.
- `counter` guards must have a terminal target or a same-step `fallback` transition to a terminal.
- Missing structured parameters are reported in author terms.
- The Slice-1 action permission validator seam is unchanged; Slice 3b still owns that gate.

## Runner Evaluation

- For each transition choice, the runner evaluates structured guards purely, in declared edge order.
- If no structured guard matches, legacy `llm`/condition edges are passed to the selector exactly as before.
- Fallback is used only when no structured or selector edge wins.
- Tool/skill outcome branches with structured `outcome` guards are selected deterministically; no selector call is made for covered results.
- Counter guards read the `attempts[fromStepId]` count. This enforces bounded retries without LLM counting.
- Handoff terminals clear routine state and set a distinct handoff marker; no outbox action is emitted for handoff.

## Parity

- Routines with no `guard` fields, including the code-defined contact routine shape, keep the old selector path.
- Legacy single-edge skill steps still auto-advance without selector calls.
- The contact parity tests stayed green after the structured guard changes.

## Test Results

- `pnpm --dir packages/conversation-engine test` passed: 4 files, 60 tests.
- `pnpm --dir packages/conversation-defaults test` passed: 5 files, 26 tests.
- `pnpm exec vitest run tests/unit/routine-definition-*.test.ts tests/unit/routine-next-step-selector.test.ts` from `backend/` passed: 5 files, 33 tests.
- Contact-flow tests passed:
  - engine contact parity is included in `packages/conversation-engine test`
  - `pnpm --dir backend exec vitest run tests/unit/contact-routine.test.ts tests/unit/contact-routine-module.test.ts tests/unit/contact-send-action-handler.test.ts` passed: 3 files, 22 tests.
- `pnpm --dir backend exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm --dir backend run lint:boundaries` passed.
