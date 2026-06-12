# Tasks: 082 Amendment Versioning & Lifecycle

**Spec**: `amendment-versioning-lifecycle.md` | **Plan**: `plan-versioning-lifecycle.md`
**Ordering**: phases are dependency-ordered; [P] = parallelizable within its phase. Backend phases are TDD: test tasks precede implementation and must fail first.

## Phase 1 — Lineage + status model (amendment §7.1, FR-025/026/027/029)

- [X] T001 Write failing repository tests in `backend/tests/unit/routine-definition-repository.test.ts` (or sibling new file): lineage-keyed version increment; publish supersedes prior published row of same lineage and deletes the draft row; at most one draft and one published per lineage enforced; `createRevisionDraft` copies steps/slots/transitions/terminals/completion-export with stable ids and lineage preserved; archive only from published; restore only when no published version exists in lineage; rename keeps lineage (SC-021).
- [X] T002 Write failing service tests in `backend/tests/unit/routine-definition-service.test.ts`: revise returns existing draft when one exists; archive/restore legality errors (400/404); publish result shape includes scope-orphan list (empty when no directives port wired); audit events emitted for publish/supersede, revise, archive, restore.
- [X] T003 Migration `backend/src/db/migrations/090_routine_lineage_lifecycle.sql`: add `lineage_id UUID`; backfill per `(agent_id, name)`; mark all but the newest published row per lineage `superseded` (retro-fix of double activation, plan §Backfill); `NOT NULL`; extend status CHECK to four states; partial unique indexes (one draft / one published per lineage); `(agent_id, lineage_id)` index.
- [X] T004 Repository: lineage-aware `publish` (advisory lock per lineage, supersede + consume draft in one transaction), `createRevisionDraft`, `archive`, `restore`, `findByIdAnyStatus`, expose `lineageId` on `RoutineDefinition` mapping; defensive status normalization not required (no legacy values).
- [X] T005 Domain/service: `RoutineDefinition.status` union + Zod schemas in `backend/src/modules/routines/domain.ts` gain `superseded|archived` and `lineageId`; `RoutineDefinitionService.revise/archive/restore` with legality rules; audit-event emission per plan Observability.
- [X] T006 Run Phase 1 tests green; record evidence in `specs/082-routines-as-data/slice-vl-notes.md`.

## Phase 2 — Pinned-version runtime resolution (amendment §7.2, FR-028)

- [X] T007 Write failing integration test `backend/tests/integration/routine-lifecycle.integration.test.ts`: conversation enters routine v1 → publish v2 → same session continues and completes on v1; a new session activates v2 only (SC-017); archived lineage never activates but pinned session completes (SC-019).
- [X] T008 `backend/src/app/composition/routineDefinitionSource.ts`: add pinned load (`findByIdAnyStatus`-backed) returning resume-only registrations; warn log when a pinned definition fails to load/compile.
- [X] T009 `backend/src/modules/chat/composition.ts` `RoutineRegistry` (+ `backend/src/app/server/dependencyBuilders.ts` provider): accept resume-only routines — included in the runner's routine list, excluded from activation candidates; `forTurn` receives the session/conversation id from ChatService. Engine packages unchanged (verify by diff).
- [X] T010 Run Phase 2 tests green; evidence in slice notes.

## Phase 3 — Scoped-directive re-pointing (amendment §7.3, FR-030)

- [X] T011 Write failing tests: directives-repository port test (re-point `routine:<old>` / `step:<old>:<stepId>` tags to new id when step survives; orphans returned for removed steps, tags untouched) + service publish-flow test asserting orphans surface in the publish result (SC-020).
- [X] T012 Implement `repointRoutineScopeTags` in the directives-owning repository (`backend/src/db/repositories/agentRepository.ts` or its directives sibling — locate actual owner of `scope_tags`), transactional with publish per plan §Contract decisions.
- [X] T013 Wire the port through `RoutineDefinitionService.publish`; include `directiveScopeOrphans` in the publish response; run tests green; evidence in slice notes.

## Phase 4 — HTTP contract + OpenAPI + SDK (amendment §7.4, FR-031/032 contract half)

- [ ] T014 Contract tests first: extend `backend/tests/contract` routine coverage for `POST /agents/:agentId/routines/:routineId/revise|archive|restore`, `lineageId` + 4-state `status` on read/list, publish response orphans field.
- [ ] T015 Routes in `backend/src/app/http/routes/agentRoutes.ts` (thin handlers, `agentManage` permission, existing error mapping).
- [ ] T016 Code-first OpenAPI registry (`backend/src/app/http/openapi/schemas/agentSchemas.ts`, `paths/agentsPaths.ts`); regenerate `backend/openapi.{yaml,json}`, `typescript-sdk/openapi/radioso.{yaml,json}`, `typescript-sdk/src/generated/types.ts`, `packages/radioso-mcp-server/src/generated/openapiTypes.ts` via repo scripts (no hand edits); SDK sync/build/test.
- [ ] T017 Message-queue impact review: search worker payload builders / AMQP contracts for routine definition references; record evidence + conclusion (expected: none) in slice notes.

## Phase 5 — Dashboard (amendment §7.5, FR-031, SC-018)

- [ ] T018 Pure lineage grouping helper `frontend/lib/routine-lineage.ts` + unit tests `frontend/tests/unit/routine-lineage.test.ts` (group by lineageId; active-version selection; pending-draft badge state; archived partition) — no markup assertions.
- [ ] T019 API adapter `frontend/lib/api-routines.ts` + `frontend/lib/api-types.ts`: revise/archive/restore calls, `lineageId`, 4-state status.
- [ ] T020 `frontend/components/dashboard/settings/assistant-routines-section.tsx`: lineage-grouped list (one row per lineage, status + active version + draft badge), archived section with restore, version-history panel in details (read-only past versions), Edit-on-published → revise → open draft. Reuse existing Radix/shadcn patterns.
- [ ] T021 Playwright `frontend/tests/e2e/routines-settings.spec.ts`: revise→publish supersede journey (list still one row, history shows v1 superseded + v2 published), archive→restore journey, draft-badge visibility.

## Phase 6 — Docs + polish (amendment §7.6, FR-032 docs half)

- [ ] T022 Read `docs/document-writer-prompt.md`; update `docs/authoring-routines.md` (lifecycle: revise → publish → supersede, archive/restore, in-flight pinning) and any docs enumerating routine statuses or routines API endpoints (incl. docs-portal if routines are documented there).
- [ ] T023 Update `specs/082-routines-as-data/` parent artifacts only where they assert the two-state lifecycle as current behavior; final slice notes with validation evidence.
- [ ] T024 Full gate: `pnpm run ci:local -- origin/main`; record result.

## Dependencies

Phase 1 → 2 → 3 → 4 → 5 → 6. T008/T009 within Phase 2 may interleave; T018/T019 are [P].
