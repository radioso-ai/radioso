# Implementation Plan: Routine Dispatch Hardening & Non-Linear Flow (Jumps)

**Branch**: active branch (post-#720 main) | **Date**: 2026-06-15 | **Spec**: [spec.md](./spec.md)
**Depends on**: spec 087 (merged in #720)

## Summary

Land four items deferred from 087, now that routine `skill` steps are live. Two harden the dispatch path to chat-parity (capability gate, observability); one removes the retired Outline editor; one activates the reserved `step` chip for non-linear flow (jumps). The conversation engine/contract stay unmodified — the dispatch contract `ConversationRoutineSkillDispatcher.dispatch({skillName, state, turn})` does not change; per-turn dependencies (capability policy, workspace id, tracer, metrics) are **closed over at `forTurn()` construction time** in `dependencyBuilders.ts` (where `workspaceId`/`agentId` are in scope, line 951), mirroring how the chat path injects `capabilityPolicy` into `SkillRetrievalTurnDispatch`.

## Governing constraints (from the 087 seams)

1. **No contract/engine change.** `RoutineSkillExecutorDispatcher` is host-side (`backend/src/modules/routines/`); all new dependencies go into *its constructor*, supplied by composition. Threading agent/workspace/policy into the contract is rejected (cross-service contract bump for a host-only concern). Add a boundary test (mirror 087 SC-006) that `packages/conversation-engine` and `packages/conversation-contract` are untouched.
2. **Degrade, never throw.** Every new failure mode (capability denied) returns `unavailable(skillName, reason)` — the existing settled-`failed` pattern (`skillDispatcher.ts:100-102`) — so the resumable state machine advances. This is the single most important behavioral invariant (`skillDispatcher.ts:57-62`).
3. **Two orthogonal gates, not collapsed.** Per-agent existence/enabled lives in `McpSkillExecutor.findEnabledByName` (087). The workspace `CapabilityPolicy` gate (this spec) is a *different* axis. Keep them separate.
4. **PII discipline is manual.** `attributePolicy.ts` blocks keys containing prompt/completion/chunk/token/secret — it does **not** auto-block `outputs`/`answer`/`variables`. Use an explicit allow-list of attributes (ids + status + reason only).

## Workstream → PR → owner

| PR | Story | Scope | Owner |
|----|-------|-------|-------|
| **PR-1** | US3 | Delete retired Outline modules | **Claude (frontend)** |
| **PR-2** | US1 + US2 | Capability gate + observability on `RoutineSkillExecutorDispatcher` | **Codex (backend)** |
| **PR-3a** | US4 | Backend: `step` flow-target round-trip + back-edge bounding-guard validator rule | **Codex (backend)** |
| **PR-3b** | US4 | Frontend: activate `step` chip in the prose editor + round-trip | **Claude (frontend)** |

PR-1 is independent (land first/parallel). PR-2 is self-contained backend. PR-3a (backend document/validator) lands before PR-3b (frontend chip) so the round-trip target exists; they may be one PR if coordination is cheap.

## Technical approach

### PR-2 — Capability gate (US1)

- Add `externalSkills: { invoke: "external_skills.invoke" }` to `capabilityNames` (`backend/src/shared/domain/capabilityPolicy.ts:1-22`). (Alternative considered: reuse the `mcp` group — rejected: `mcp.*` is the Radioso-*as-MCP-server* surface, not external MCP clients. A distinct group reads correctly.)
- Set `requiredCapabilities: [capabilityNames.externalSkills.invoke]` on `externalSkillRoutineDefinition` (`backend/src/modules/externalSkills/routineSkillResolver.ts:5-21`).
- Extend `RoutineSkillExecutorDispatcher` constructor with a narrow capability gate. Prefer a pre-bound closure `(capability: string) => Promise<CapabilityDecision>` over passing raw `CapabilityPolicy` + a bare `workspaceId` string, so the dispatcher knows "can I ask whether a capability is allowed," not "what a workspace is" (narrow-port rule). Build it at `forTurn` from `input.composition.capabilityPolicy` + closure `workspaceId`.
- In `dispatch`, after resolving the skill (`skillDispatcher.ts:63-73`) and before `executor.dispatch` (line 75), check each `skill.requiredCapabilities`; on first denial return `unavailable(skillName, "capability_denied")`. Mirror `SkillRetrievalTurnDispatch.firstDeniedCapability` (`retrievalTurnDispatch.ts:145-153`) but with the degrade result, not `effectiveWithRetrieval=false`.
- Guard against `assertKnownCapabilityName` throwing on an unknown capability (`capabilityPolicy.ts:50-54`) surfacing as a 500: the capability is a registered name by construction, but degrade defensively.

### PR-2 — Observability (US2)

- Wrap `RoutineSkillExecutorDispatcher.dispatch` body in `traceOperation` (`backend/src/shared/observability/tracing/operations.ts`), span name `routine.skill.dispatch`. The dispatcher (not the executor) is the right home: it has the routine context (`state.routineId`, current step `state.path.at(-1)`) and sees every failure mode incl. those that never reach the executor. The span nests under the turn span via active-context propagation (no parent threading).
- Attributes (explicit allow-list only): `routine.id`, `routine.step_id`, `skill.name`; `resultAttributes` → `outcome.status` + `outcome.reason` (the `unavailable` reason / `capability_denied` / executor status).
- Increment a dispatch metric via `backend/src/shared/observability/metrics/metricsRegistry.ts`, labelled by outcome (bounded label set). No high-cardinality labels (no ids in labels).
- The dispatcher needs the tracer/metrics handles — inject via constructor from composition (or rely on the ambient tracer if `traceOperation` reads the active tracer; confirm the metrics registry access pattern from an existing call site).

### PR-1 — Outline cleanup (US3)

- Delete `frontend/lib/routine-outline.ts`, `frontend/components/dashboard/settings/routine-outline-editor.tsx`, `frontend/tests/unit/routine-outline.test.ts`.
- First prove zero production importers (grep `routine-outline` / `RoutineOutlineEditor` excluding the deleted files). If any non-test importer exists, stop.
- Preserve `outlineLabel` in step metadata + fixtures (`backend/.../routine-draft-assist.test.ts`, `frontend/tests/e2e/dashboard-fixtures.ts`). Keep the e2e guard (`routines-settings.spec.ts`) green.
- Optional: retire `StaticRoutineSkillResolver` if it is now only referenced by its own test (post-#720 it is no longer wired; `ExternalSkillRoutineSkillResolver` replaced it). Confirm before deleting; out of scope if entangled — note it for PR-2's Codex owner since it lives in backend.

### PR-3 — Jumps (US4)

- **Runtime already supports it** — no engine change. The runner follows any declared successor (`routineRunner.ts:281-284`) and bounds loops via the `counter` guard (`routineRunner.ts:307-308`) over persisted attempts. **Do not add a `"jump"` flow-target kind** — a jump is a `step`-targeted branch the runtime already represents (`RoutineFlowTargetKind = "step" | "end"`, `document/model.ts:43`). Adding `"jump"` would model a distinction the contract cannot carry (over-modeling).
- **PR-3a backend**: ensure `routineDraftToDocument`/`routineDocumentToDraft` (`backend/src/modules/routines/document/transform.ts:59-62`) round-trip a `step`-target branch whose target is a non-adjacent step (forward or backward). Add the FR-008 validator rule (`validator.ts`): detect a back-edge (target not strictly after source in flow order) and require a bounding guard (`counter`, or another deterministic terminating guard); reuse the existing counter-limit check. Keep the `dangling_step_reference` rule (`validator.ts:118-124`).
- **PR-3b frontend**: offer the reserved `step` chip in the typeahead (`frontend/components/dashboard/settings/routine-chip-editor.tsx:~368`, currently only `skill`/`handoff`); render it (`routine-chip-node.tsx:37`, `step` already in `RoutineChipKind`); serialize/deserialize it in `draftFromChipDoc`/`branchSegments` (`frontend/lib/routine-prose.ts:113-256`, the docstring already names "step-jump targets are later increments"). Never offer reserved terminal ids `done`/`handoff` (`routine-prose.ts:100-101`) as jump targets.

## Constitution Check

- ✅ Backend TDD: PR-2, PR-3a write failing tests first (capability denial/allow/no-capability; span+metric on success/failure; back-edge validator; round-trip).
- ✅ Frontend: Playwright for the jump-authoring journey (PR-3b) and the outline-removed guard (PR-1, existing); unit tests only for prose↔draft transform logic.
- ✅ No English keyword lists / product-meaning regexes added.
- ✅ Observability reviewed (US2): new span + metric on a live routine path; PII allow-list enforced; no raw content.
- ✅ Docs are product surface: routine authoring docs document the jump (`step`) chip; the external-skill capability is operator-relevant (note in the per-agent skill/capability docs).
- ✅ Contract review: no public API / SDK / MCP / worker / queue contract change; engine/contract packages untouched (boundary test).

## Risks

- **Fail-open capability bug** (PR-2): a missed gate authorizes a denied skill. Covered by the deny/allow/no-capability tests.
- **Fail-wedge** (PR-2): a denial that throws instead of degrading. Covered by the "never-throw" test.
- **PII leak on spans** (PR-2): mitigated by the explicit attribute allow-list (no auto-block for `outputs`/`answer`).
- **Lossless prose round-trip** (PR-3): the explicit concern from #717 (commit 80a2a2c3a). Covered by the transform round-trip test.
- **Unbounded loop** (PR-3): a back-edge without a guard; FR-008 validator rule + the runtime `routine_walk_exceeded` backstop both guard it.
