# Tasks: 082 Amendment Authoring Surface Slice 1

**Input**: `specs/082-routines-as-data/amendment-authoring-surface.md`
**Plan**: `specs/082-routines-as-data/plan-authoring-surface.md`

## Phase 1: Setup

- [X] T001 Verify branch `routine-text-composer` and confirm existing user changes before edits.
- [X] T002 Create amendment planning artifacts in `specs/082-routines-as-data/plan-authoring-surface.md` and `specs/082-routines-as-data/tasks-authoring-surface.md` without modifying shipped `plan.md`.

## Phase 2: Tests First

- [X] T003 [P] Add failing golden round-trip tests for `draft -> document -> draft` and `draft -> text -> parse -> draft` in `backend/tests/unit/routine-document-roundtrip.test.ts`.
- [X] T004 [P] Add failing tests for branch-vs-nuance and token-less-beat diagnostics in `backend/tests/unit/routine-document-roundtrip.test.ts`.
- [X] T005 [P] Add failing tests for source-map mapping of validator-style locations in `backend/tests/unit/routine-document-roundtrip.test.ts`.

## Phase 3: Document Module

- [X] T006 Add document AST and source-map types in `backend/src/modules/routines/document/model.ts`.
- [X] T007 Implement pure draft/document projection in `backend/src/modules/routines/document/transform.ts`.
- [X] T008 Implement fixture parser/serializer in `backend/src/modules/routines/document/fixture.ts`.
- [X] T009 Add public exports in `backend/src/modules/routines/document/index.ts` and `backend/src/modules/routines/public.ts`.

## Phase 4: Validation

- [X] T010 Run focused backend tests: `cd backend && pnpm test -- tests/unit/routine-document-roundtrip.test.ts`.
- [X] T011 Run backend unit suite: `cd backend && pnpm run test:unit`.
- [X] T012 Record decisions and validation evidence in `specs/082-routines-as-data/slice-doc1-notes.md`.

## Phase 5: Review And Handoff

- [X] T013 Run senior engineer review loop and address blocking findings.
- [X] T014 Run engineering manager delivery pass and address in-scope feedback.
- [ ] T015 Commit locally on `routine-text-composer` with a Conventional Commit message; do not push or open a PR.

## Dependencies

Tests T003-T005 must be authored before implementation T006-T009. Validation T010-T012 depends on implementation. Review and local commit depend on validation.
