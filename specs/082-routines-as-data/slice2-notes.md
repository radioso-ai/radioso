# Slice 2 Notes — Typed Slots + Fast-Forward Traversal

## Independent verification (orchestrator, 2026-06-09)

- **Engine package**: 56 tests pass (incl. fast-forward + contact-parity). **Defaults**: 26 pass.
- **Full backend parity net**: rebuilt packages + `tsc` clean; `vitest run tests/unit tests/contract` → **1838 tests pass** (251 files) — the contact flow and all chat/routine paths exercise the modified runner and stay green. **Boundaries** clean (556 modules).
- **Parity is by construction**: `isSatisfiedSlotCollectionStep` returns false unless `step.kind === "chat" && hasTypedSlotSchema(routine)`, so any routine without a typed slot schema (incl. the code-defined `contactRoutine`) never fast-forwards — identical behaviour to before. The fast-forward loop is bounded by `routine.steps.length`, breaks if the selector stays, sits *before* the existing tool/action loop, and the final render still uses `projectStep` + #664's `steeringResolver`.
- **Contract change is additive**: `Routine.slots?` is optional.

## Contract Change

- Added optional `Routine.slots?: RoutineSlotSchema[]` to `@radioso/conversation-contract`.
- `RoutineSlotSchema` is `{ id; key; type; required; description? }`, with `type` limited to `"text" | "number" | "boolean" | "email" | "date"`.
- `RoutineState.variables` remains `Record<string, unknown>` and is keyed by slot `key`.
- Routines without `slots` keep legacy behavior.

## Compiler Change

- `compileRoutineDefinition()` now promotes the authored slot schema to `Routine.slots`.
- The existing `Routine.metadata.slotSchema` is retained for compatibility.
- Each authored routine step instruction is scanned once at compile time for `{{slot.key}}` references.
- Steps that reference slots get `metadata.collectsSlots: string[]`; steps with no slot references do not get collection metadata.

## Selector Change

- `RoutineNextStepSelector` now includes the typed slot schema in the prompt only when `routine.slots` is present.
- The prompt instructs the model to extract every declared slot present in the latest user message in one pass and return values keyed by slot `key`.
- No-schema routines receive a blank slot-schema prompt block, preserving current behavior.

## Fast-Forward Logic

- After the initial selector decision is constrained and variables are merged, `DefaultRoutineRunner.resume()` runs a bounded fast-forward loop.
- A step is eligible only when:
  - the routine has typed `slots`;
  - the landed step is `kind: "chat"`;
  - the step has compiler-provided `metadata.collectsSlots`;
  - every collected slot key is already present in accumulated variables.
- Eligible single-edge chat steps advance deterministically without another selector call.
- Eligible multi-edge chat steps re-invoke the selector with accumulated state and still pass through the existing landing-step guard.
- The loop is bounded by `routine.steps.length`.
- The existing tool/action loop, terminal clear-on-complete, `yieldTurn`, path persistence, `projectStep(step)`, and `steeringResolver` final render behavior are preserved.

## Backward Compatibility

- No auto-skip happens unless `Routine.slots` exists and the step has `metadata.collectsSlots`.
- Code-defined/contact-shaped routines without a typed slot schema remain one-step-per-turn even if variables already contain later values.
- Existing contact-flow tests still pass.

## Test Results

- Failing-first checkpoint:
  - `pnpm --dir packages/conversation-engine exec vitest run tests/defaultRoutineRunner.test.ts` failed on the new fast-forward terminal assertion before implementation.
  - `pnpm --dir backend exec vitest run tests/unit/routine-next-step-selector.test.ts tests/unit/routine-definition-domain.test.ts` failed on missing prompt slot schema and missing compiler metadata before implementation.
- Final verification:
  - `pnpm --dir packages/conversation-engine test` passed: 4 files, 56 tests.
  - `pnpm --dir packages/conversation-defaults test` passed: 5 files, 26 tests.
  - `pnpm --dir backend exec vitest run tests/unit/routine-definition-domain.test.ts tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-service.test.ts tests/unit/routine-definition-composition.test.ts` passed: 4 files, 18 tests.
  - `pnpm --dir backend exec vitest run tests/unit/routine-next-step-selector.test.ts` passed: 1 file, 12 tests.
  - Contact-flow tests passed:
    - `pnpm --dir backend exec vitest run tests/unit/contact-routine.test.ts tests/unit/contact-routine-module.test.ts` passed: 2 files, 7 tests.
    - `pnpm --dir packages/conversation-engine exec vitest run tests/contactRoutineParity.test.ts` passed: 1 file, 3 tests.
  - `pnpm --dir backend exec tsc -p tsconfig.json --noEmit` passed.
  - `pnpm --dir backend run lint:boundaries` passed.

Note: the literal requested shell command `pnpm --dir backend exec vitest run tests/unit/routine-definition-*.test.ts` failed under `zsh` before Vitest ran because the glob was expanded from the repo root. The equivalent matching files were run explicitly and passed.
