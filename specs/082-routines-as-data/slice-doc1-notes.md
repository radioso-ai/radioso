# Slice 1 Notes: Document Authoring Core

**Date**: 2026-06-11
**Branch**: `routine-text-composer`
**Scope**: `amendment-authoring-surface.md` §12 item 1 only.

## Delivered

- Added the routine document AST and source-map types under `backend/src/modules/routines/document/`.
- Added pure `RoutineDefinitionDraftInput -> RoutineDocument -> RoutineDefinitionDraftInput` projection.
- Added engineer-facing fixture serialization and parser.
- Added source-map lookup for existing validator-style locations (`step:<id>`, `slot:<key>`, `transition:<from>-><to>`, `routine:<name>`).
- Added golden tests covering:
  - `draft -> document AST -> draft`
  - `draft -> text -> parse -> draft`
  - every current guard kind: `always`, `fallback`, `llm`, `slot_filled`, `outcome`, `counter`
  - branch-vs-nuance
  - token-less branch beat diagnostic
  - guidelines/glossary placeholder sections
  - `@` name collision between variable and action reference sets

## Finalized §14.4 Decisions

- **Counter × outcome**: not combined in slice 1. Fixture notation enforces one guard marker per edge; `if` prose, `[status]` / `[needs ...]`, and `↺N` are mutually exclusive. This matches the existing draft model's single `guardKind` field. Runtime counter-exhaustion semantics remain a slice-2/schema-cut concern.
- **Nested sub-step notation**: nested conversational beats are represented as explicit anchored steps in fixture text. An indented `if` body with no target is rejected with the author-term diagnostic: "this branch needs a destination: declare a step, choose an end, or fold it into the instruction." This avoids silent node creation and preserves stable ids.

## Boundary Review

- No UI changes.
- No schema changes or migrations.
- No prompt assets.
- No API endpoints or OpenAPI/SDK/MCP changes.
- No imports from `packages/conversation-engine` or `packages/conversation-contract` were added by the document module (`rg` check returned no matches).
- The parser uses fixture grammar keywords and structural sigils only. Action kind inference is catalog-driven via parser options, not English action-name matching.

## Observability Review

No observability was added. This slice introduces no runtime path, worker job, queue handoff, provider call, retry, fallback, degradation behavior, or operator-relevant latency. The module is a pure transform/parser library used by future slices.

## Validation Evidence

Initial attempted validation before dependencies were installed:

```bash
cd backend && pnpm test -- tests/unit/routine-document-roundtrip.test.ts
```

Result: failed before running tests. `pnpm` invoked `build:conversation-engine`; TypeScript could not create `packages/conversation-engine/dist/*` (`TS5033: EPERM`) and also reported missing `@radioso/conversation-contract` types. The command ended with the pnpm warning that local `node_modules` is missing.

Attempted:

```bash
cd backend && pnpm run test:unit
```

Result: same pre-test failure in `build:conversation-engine` (`TS5033: EPERM`, missing `@radioso/conversation-contract`, missing `node_modules`).

Attempted dependency repair:

```bash
pnpm install --offline --frozen-lockfile
```

Result: failed because the pnpm store is missing `@asteasolutions/zod-to-openapi@7.3.4` and offline mode cannot download it.

Attempted direct typecheck:

```bash
tsc -p backend/tsconfig.json --noEmit
```

Result: failed before project checking because `@types/node` and `vitest/globals` type definitions are not installed.

Repeated after senior-review fixes:

```bash
cd backend && pnpm test -- tests/unit/routine-document-roundtrip.test.ts
cd backend && pnpm run test:unit
```

Result: unchanged pre-test failure in `build:conversation-engine` (`TS5033: EPERM`, missing `@radioso/conversation-contract`, missing `node_modules`).

Post-EM verification fix, after dependencies were installed in the worktree:

```bash
cd backend && pnpm vitest run tests/unit/routine-document-roundtrip.test.ts
```

Initial result reproduced the EM failure: 5 failed / 9 total. The failure was caused by mention parsing including trailing punctuation in token names, so prose leaves such as terminal instructions kept `@email.` instead of decoding to `{{slot.email}}.`; action detection had the same issue for `@ticket_notify.` / `@OrderDetails.`.

Fix: normalize trailing punctuation when resolving `@` mentions and apply the same mention parser to step instructions, LLM guard text, terminal instructions, and action-token detection.

Final focused result:

```text
Test Files  1 passed (1)
Tests       9 passed (9)
Duration    224ms
```

Attempted exact broad command:

```bash
cd backend && pnpm run test:unit
```

Result: failed before Vitest because `build:conversation-engine` invokes `pnpm --dir ../packages/conversation-engine run build` from `backend`, and TypeScript cannot open files under `packages/conversation-engine/dist` in this sandbox (`TS5033: EPERM`). Running the same package build directly from the repo root succeeds:

```bash
pnpm --dir packages/conversation-engine run build
pnpm --dir packages/conversation-defaults run build
pnpm --dir packages/radioso-mcp-server run build
```

After root-level package prebuilds, direct backend unit execution was attempted:

```bash
cd backend && pnpm vitest run tests/unit
```

Result: the unit test body ran but the suite did not pass in this sandbox. Summary:

```text
Test Files  13 failed | 227 passed (240)
Tests       77 failed | 1638 passed (1715)
Errors      72 errors
```

The failures are unrelated Supertest/server-listen sandbox failures (`listen EPERM: operation not permitted 0.0.0.0`) in existing route/webhook/HTTP tests. The focused routine document tests pass.

## Review Evidence

Senior engineer review loop:

- Pass 1 found missing multiline fixture parsing, missing routine-level source-map ranges, and missing §8.4 worked-example coverage. Fixed by multiline step continuation parsing, frontmatter source-map ranges, and a §8.4 golden fixture using explicit anchored nested beats.
- Pass 2 found missing implicit outline fall-through edges. Fixed by synthesizing `always` transitions from branchless steps to the next ordered step and adding direct-AST plus parsed-fixture coverage.
- Pass 3 found no blocking issues. Remaining gap: tests could not execute in this environment.

Engineering manager pass:

- Scope fit and module boundary accepted for §12 item 1.
- Release/merge readiness remains blocked until focused golden tests and `pnpm run test:unit` run successfully in a valid dependency/build environment, or that validation gap is explicitly accepted.

## Commit Status

Attempted:

```bash
git add specs/082-routines-as-data/amendment-authoring-surface.md specs/082-routines-as-data/plan-authoring-surface.md specs/082-routines-as-data/tasks-authoring-surface.md specs/082-routines-as-data/slice-doc1-notes.md backend/src/modules/routines/public.ts backend/src/modules/routines/document backend/tests/unit/routine-document-roundtrip.test.ts
```

Result: blocked by filesystem permissions. Git needs to create `/Users/dm/code/radioso/.git/worktrees/seattle/index.lock`, which is outside this session's writable roots, and returned `Operation not permitted`. No local commit was created.
