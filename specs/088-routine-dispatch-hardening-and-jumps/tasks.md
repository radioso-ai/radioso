---
description: "Task list for Routine Dispatch Hardening & Non-Linear Flow (Jumps)"
---

# Tasks: Routine Dispatch Hardening & Non-Linear Flow (Jumps)

**Input**: `specs/088-routine-dispatch-hardening-and-jumps/` (spec.md, plan.md)
**Tests**: Backend TDD REQUIRED — failing tests before implementation. Frontend user-visible behavior → Playwright; frontend unit tests only for non-visual logic (prose↔draft transform).
**Ownership**: `[C]` = Codex (backend), `[K]` = Claude (frontend). Orchestrator (Claude) verifies every Codex result independently.

## PR-1 — Remove the retired Outline editor (US3) — `[K]`

- [ ] T101 `[K]` Prove zero production importers of `routine-outline` / `RoutineOutlineEditor` (grep excluding the three target files). Abort if a non-test importer exists.
- [ ] T102 `[K]` Delete `frontend/lib/routine-outline.ts`, `frontend/components/dashboard/settings/routine-outline-editor.tsx`, `frontend/tests/unit/routine-outline.test.ts`.
- [ ] T103 `[K]` Preserve `outlineLabel` step-metadata + fixtures; keep the e2e guard `frontend/tests/e2e/routines-settings.spec.ts` green.
- [ ] T104 `[K]` `cd frontend && pnpm run build && pnpm run lint`; run the routines e2e guard.
- [ ] T105 `[C]` (optional, backend) If `StaticRoutineSkillResolver` is now referenced only by its own test post-#720, retire it; else leave and note. Confirm with grep first.

## PR-2 — Capability gate + observability on routine dispatch (US1 + US2) — `[C]`

### Tests first (write, ensure FAIL)

- [ ] T201 `[C]` Capability tests in `backend/tests/unit/routine-skill-dispatcher.test.ts`: (a) denied capability → `unavailable(skillName, "capability_denied")`, executor NOT invoked; (b) allowed → executor invoked; (c) skill with empty `requiredCapabilities` → no policy call, dispatches; (d) denial never throws. Use `StrictCapabilityPolicy`/`DefaultAllowCapabilityPolicy` doubles (`capabilityPolicy.ts:56-80`).
- [ ] T202 `[C]` Observability tests: dispatch records a `routine.skill.dispatch` span with `routine.id`/`routine.step_id`/`skill.name`/`outcome.status` on success and on `unavailable`; a metric is incremented by outcome; no blocked/PII attribute present. Reuse the existing tracing test harness used for retrieval/LLM spans.

### Implementation

- [ ] T203 `[C]` Add `externalSkills.invoke = "external_skills.invoke"` to `capabilityNames` (`backend/src/shared/domain/capabilityPolicy.ts`).
- [ ] T204 `[C]` Set `requiredCapabilities: [capabilityNames.externalSkills.invoke]` on `externalSkillRoutineDefinition` (`backend/src/modules/externalSkills/routineSkillResolver.ts`).
- [ ] T205 `[C]` Extend `RoutineSkillExecutorDispatcher` (`backend/src/modules/routines/skillDispatcher.ts`) with a narrow capability-gate closure + tracer/metrics handles; add the `requiredCapabilities` check (degrade to `capability_denied`) and the span/metric per plan. Keep the never-throw invariant.
- [ ] T206 `[C]` Wire it in `dependencyBuilders.ts` `forTurn` (line ~951-1027): build the gate from `input.composition.capabilityPolicy` + closure `workspaceId`; pass tracer/metrics. No engine/contract change.
- [ ] T207 `[C]` Boundary test (mirror 087 SC-006): assert no new import into `packages/conversation-engine` / `packages/conversation-contract` from this change.
- [ ] T208 `[C]` Docs: note the `external_skills.invoke` capability where per-agent capabilities/skill gating is documented; note the `routine.skill.dispatch` span if an emitted-spans doc exists.

## PR-3a — Jumps: backend round-trip + loop-safety (US4) — `[C]`

### Tests first (write, ensure FAIL)

- [ ] T301 `[C]` Round-trip test (`backend/tests/unit/routine-document-roundtrip.test.ts` or peer): a `step`-target branch to a NON-adjacent step (forward and backward) survives `routineDraftToDocument` → `routineDocumentToDraft`; the compiled transition's `to` equals the target step id.
- [ ] T302 `[C]` Validator tests: a back-edge (target not strictly after source) WITHOUT a bounding guard raises the new diagnostic; WITH a `counter` guard passes; a `step` chip to an unknown step raises `dangling_step_reference`; `done`/`handoff` are never valid step-jump targets.

### Implementation

- [ ] T303 `[C]` Ensure `transform.ts` (`backend/src/modules/routines/document/transform.ts:59-62`) round-trips `step`-target branches to non-adjacent steps (no `"jump"` kind added).
- [ ] T304 `[C]` Add the FR-008 back-edge bounding-guard rule to `backend/src/modules/routines/validator.ts` (reuse the counter-limit check; add a diagnostic code). Keep `dangling_step_reference`.
- [ ] T305 `[C]` Confirm the compiler keys edges on stable ids only (`compiler.ts:145-155`) — no change expected; add a focused test if a gap appears.

## PR-3b — Jumps: frontend authoring (US4) — `[K]`

- [ ] T306 `[K]` Offer the reserved `step` chip in the typeahead (`frontend/components/dashboard/settings/routine-chip-editor.tsx`); render it (`routine-chip-node.tsx`, `step` already in `RoutineChipKind`).
- [ ] T307 `[K]` Serialize/deserialize the `step` chip in `draftFromChipDoc`/`branchSegments` (`frontend/lib/routine-prose.ts:113-256`); never offer reserved terminal ids `done`/`handoff` as targets.
- [ ] T308 `[K]` Unit test the prose↔draft transform for a step-jump branch (logic only).
- [ ] T309 `[K]` Playwright: author a routine, insert a `step` chip targeting an existing step, save, reopen, confirm the jump round-trips.
- [ ] T310 `[K]` Docs: document the step-jump (`step`) chip in routine authoring docs (read `docs/document-writer-prompt.md` first).

## Cross-cutting

- [ ] T401 Run `pnpm run ci:local -- origin/main` before each PR (use `--all` for PR-2 since it touches a live dispatch path). Use `pnpm exec vitest run <path>` for targeted backend runs.
- [ ] T402 Confirm no message-queue / worker / SDK / MCP contract impact (none expected).

## Dependencies & order

- PR-1 independent (land first/parallel).
- PR-2 self-contained backend.
- PR-3a before PR-3b (frontend needs the round-trip target).
- Tests before implementation in every backend task group (constitution).
