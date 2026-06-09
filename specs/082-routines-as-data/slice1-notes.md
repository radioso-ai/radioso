# Slice 1 Notes

## Files Added / Changed

- Added migration `backend/src/db/migrations/080_routine_definitions.sql`.
- Added routine authoring domain/compiler/validator module under `backend/src/modules/routines/`.
- Added `backend/src/db/repositories/routineDefinitionRepository.ts`.
- Added DB-backed composition source seam in `backend/src/app/composition/routineDefinitionSource.ts`.
- Extended application composition registry with an optional published routine source registration point.
- Added focused tests:
  - `backend/tests/unit/routine-definition-domain.test.ts`
  - `backend/tests/unit/routine-definition-repository.test.ts`
  - `backend/tests/unit/routine-definition-composition.test.ts`

## Migration Number

Used `080_routine_definitions.sql`, which is the next unused migration number visible in this local branch. The approved plan expected `083+` after PR #664, and the task text mentioned `080` as current. If a rebase introduces `080`, this migration should be renumbered before PR.

## Deterministic ID Scheme

- Compiled routine id: `routine:${agentId}:${name}:v${version}`.
- Compiled step ids: authored `stableStepId` from `routine_step` and `routine_terminal`.
- Compiled slot schema ids: authored `stableSlotId` from `routine_slot`, stored in `Routine.metadata.slotSchema`.
- Compile output ordering is deterministic by child `ordinal`, with stable id tie-breaks in repository load queries.

## Left Seams / TODOs

- Slice 3 action permission validation is intentionally left as a validator TODO seam; this slice only detects structurally dangling action references.
- The DB-backed published routine source is registered as a composition seam and compiles published definitions into normal `RoutineRegistration`s. `contactRoutine` remains registered; Slice 6 can retire it.
- No HTTP routes, OpenAPI files, SDK, MCP, UI, typed-slot runtime, fast-forward traversal, condition-gated actions, version pinning, or contact transplant were added.

## Verification

Attempted focused tests:

```bash
pnpm --dir backend run test:unit -- tests/unit/routine-definition-domain.test.ts tests/unit/routine-definition-repository.test.ts tests/unit/routine-definition-composition.test.ts
```

Result: did not reach the new tests. The command failed during `build:conversation-defaults` because local workspace package links are missing:

```text
Cannot find module '@radioso/conversation-contract' or its corresponding type declarations.
WARN Local package.json exists, but node_modules missing, did you mean to install?
```

Attempted backend build:

```bash
pnpm --dir backend run build
```

Result: same pre-build failure in `packages/conversation-defaults` before backend TypeScript compilation.

## Independent verification (orchestrator, 2026-06-09)

Codex could not run its own tests (its sandbox had no `node_modules` — workspace was never `pnpm install`ed). Re-verified after `pnpm install --frozen-lockfile`:

- **Tests**: initial full run = **1 failed / 1603 passed**. The single failure was in Codex's own integration test (`routine-definition-domain.test.ts`): its fake next-step selector advanced off the root step on the activation/trigger turn, which a faithful LLM selector would not do (confirmed against `routineRunner.ts:73-83` — the runner runs the selector every turn incl. activation, and the pure-compile test already proves `rootStepId` is correct). Fixed the fake to stay at root on the trigger turn. Re-run: **3 files, 15/15 pass.**
- **Backend typecheck**: `tsc --noEmit` clean.
- **Engine-purity boundary**: `lint:boundaries` (dep-cruiser) — no violations (553 modules). New `modules/routines` + composition seam respect boundaries.
- **Code review**: migration (FKs/CASCADE, enum CHECKs, `UNIQUE(definition_id,ordinal)`, action-terminal CHECK, arbitration-aligned index) and validator (BFS reachability + all failure classes) are substantive, not test-gaming. Repository is fully parameterized and writes only `routine_*` tables.

### Follow-ups before PR (not blockers)
1. **Transactions**: `createDraft`/`updateDraft`/`publish` + `replaceChildren` issue multiple statements with no transaction → partial-write risk. Wrap each in a transaction.
2. **updateDraft** does not verify the target row is a `draft` (silent no-op possible); check affected row count.
3. **Activation prompt** is inline in `routineDefinitionSource.ts`; per constitution, runtime prompts live under `backend/prompts/` (precedent: `routine-contact-activation.md`). Move it.
4. **Seam not yet consumed**: the published-routine source is registered but `.load()` isn't invoked at turn time yet (intended for a later slice) — track so it isn't dead wiring.
5. **Migration number**: `080` is free in this branch but `080`/`081`/`082` are taken on main / by #664; renumber to the next free number (`083+`) on rebase before PR.
