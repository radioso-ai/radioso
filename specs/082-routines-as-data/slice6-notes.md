# Slice 6 Notes: Contact Routine As Authored Data

## Independent verification (orchestrator, 2026-06-09)

- **Full backend suite**: `vitest run tests/unit tests/contract` → **1847 pass (0 fail)** (Codex's sandbox showed 272 false failures from `listen EPERM` on contract tests). `tsc` clean; `lint:boundaries` clean (557 modules).
- **Parity genuine**: the contact behavioural tests (prompts, submitted contact-request row, idempotency, receipt, activation) pass **unchanged**; the only assertion edit re-points a now-deleted `contactRoutine.id` to the compiled definition's id (same check, different source). A compile-boundary parity test asserts `compileRoutineDefinition(contactRoutineDefinition)` ≡ the previous graph. The hand-written `contactRoutine: Routine` const is retired; the module registers the compiled-from-data routine. **This proves the data→compile→run path on a real flow, through the 3b permission gate (contact agent has `human_contact.request`).**
- **Validator change is narrow + sound**: a transition may originate from an `action` terminal (so `send → done` is legal), preserving the dangling-reference check otherwise.

### Model wart to refine later (not a blocker)
The authoring model treats `action` as a **terminal** kind, but contact's `send` action must **continue** to `done` — i.e. "a terminal that isn't terminal," which forced the validator to allow follow-ups from action terminals. The cleaner model is `action` as a **step** kind (fire-and-forget, then advance), with terminals limited to `complete`/`handoff`. Worth a small follow-up refactor of the authoring model.

## Authored Definition

- `backend/src/modules/chat/services/routines/contactRoutine.ts` now exports `contactRoutineDefinition: RoutineDefinition`.
- The definition preserves the prior contact graph:
  - chat steps: `ask_email`, `ask_message`
  - action terminal: `send` with `actionType: "contact.send"`
  - complete terminals: `done`, `cancelled`
  - natural-language `llm` guards for every transition, including `send -> done`

## Retired Code

- The hand-written `contactRoutine: Routine` literal was removed.
- Shared constants remain: `CONTACT_ROUTINE_ID`, `CONTACT_SEND_ACTION_TYPE`, `CONTACT_INTENT_SKILL_NAME`, and `CONTACT_INTENT_NAME`.
- `createContactRoutineApplicationModule()` registers `compileRoutineDefinition(contactRoutineDefinition)` instead of importing a prebuilt `Routine`.

## Parity Proof

- `backend/tests/unit/contact-routine.test.ts` now compiles `contactRoutineDefinition` and runs the existing engine-level contact behavior tests against that compiled routine.
- A new compile-boundary parity test asserts the compiled graph has the retired routine's runner-facing shape:
  - same root step id
  - same step ids
  - same step kinds
  - same chat and terminal instructions
  - same `contact.send` action type
  - same transition targets and natural-language conditions
  - no structured guards added
- The validator now permits outgoing transitions from authored action terminals. This is needed for parity because the conversation engine requires action steps to auto-advance to a follow-up confirmation step.

## Permission Gate

- The contact application module still registers the `contact.send` action handler with `requiredCapabilities: [human_contact.request]`.
- The action handler registration and activation gate were otherwise left unchanged, so authorized contact agents continue through the Slice-3b action permission gate.

## Results

- Focused contact/routine checks: pass.
  - `pnpm --dir backend exec vitest run tests/unit/contact-routine.test.ts tests/unit/contact-routine-module.test.ts tests/unit/contact-send-action-handler.test.ts tests/unit/routine-definition-domain.test.ts`
  - 4 files passed, 35 tests passed.
- Package engine contact parity check found during review: pass.
  - `pnpm --dir packages/conversation-engine exec vitest run tests/contactRoutineParity.test.ts`
  - 1 file passed, 3 tests passed.
- Full backend unit + contract suite: failed in this sandbox.
  - `pnpm --dir backend exec vitest run tests/unit tests/contract`
  - 217 files passed, 34 files failed; 1575 tests passed, 272 tests failed.
  - The repeated failure mode was `listen EPERM: operation not permitted 0.0.0.0` from Supertest server binding, including contract and HTTP route tests unrelated to the contact routine change.
- Backend TypeScript no-emit: pass.
  - `pnpm --dir backend exec tsc -p tsconfig.json --noEmit`
- Backend boundary lint: pass.
  - `pnpm --dir backend run lint:boundaries`
  - No dependency violations found.
