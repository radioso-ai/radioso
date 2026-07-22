# Tasks: Fused Turn Planning

## Phase 1: Setup and design

- [X] T001 Record the approved behavior and success criteria in `specs/102-fused-turn-planning/spec.md`
- [X] T002 Record boundaries, runtime behavior, queue impact, and verification in `specs/102-fused-turn-planning/plan.md`
- [X] T003 [P] Record architecture decisions in `specs/102-fused-turn-planning/research.md`
- [X] T004 [P] Record ephemeral runtime types in `specs/102-fused-turn-planning/data-model.md`

## Phase 2: Owning-module seams

- [X] T005 [US1] Add failing routine seam characterization tests in `packages/conversation-defaults/tests/routineRegistrySeams.test.ts`
- [X] T006 [US1] Extract candidate preparation and ranked-decision application in `packages/conversation-defaults/src/routineRegistry.ts`
- [X] T007 [P] [US1] Add failing directive lifecycle and precomputed-classification tests in `backend/tests/unit/directive-lifecycle-partition.test.ts` and `backend/tests/unit/route-scoped-directive-steering.test.ts`
- [X] T008 [US1] Expose directive eligibility and precomputed resolution through `backend/src/modules/directives/` and `backend/src/modules/chat/services/routeScopedDirectiveSteering.ts`

## Phase 3: Planner fast path

- [X] T009 [US1] Add failing strict parsing, timeout, and semantic validation tests in `backend/tests/unit/turn-plan-service.test.ts`
- [X] T010 [US1] Add the canonical prompt and planner implementation in `backend/prompts/chat/turn-planning.md` and `backend/src/modules/chat/services/turnPlanService.ts`
- [X] T011 [US1] Add failing memoization, bound, and adapter tests in `backend/tests/unit/turn-plan-coordinator.test.ts`
- [X] T012 [US1] Implement the plan handle, eligibility bounds, and four adapters in `backend/src/modules/chat/services/turnPlanCoordinator.ts`
- [X] T013 [US1] Wire plan-aware live turn execution in `backend/src/modules/chat/services/chatService.ts`, `chatSessionPreparer.ts`, and `conversationProcessTurnInput.ts`
- [X] T014 [US1] Add streamed/non-streamed call-count and retrieval reuse coverage in `backend/tests/unit/chat-service-turn-planning.test.ts`

## Phase 4: Safe fallback and replay parity

- [X] T015 [US2] Add failure, bypass, cancellation, and all-or-nothing fallback coverage in `backend/tests/unit/turn-plan-service.test.ts`, `turn-plan-coordinator.test.ts`, and `chat-service-turn-planning.test.ts`
- [X] T016 [US2] Add bounded defaults in `backend/src/shared/domain/behaviorConfig.ts`
- [X] T017 [US2] Assemble the gateway, coordinator, and staged fallbacks in `backend/src/app/server/dependencyBuilders.ts`
- [X] T018 [US3] Add replay parity tests in `backend/tests/unit/workbench-replay-runner.test.ts`
- [X] T019 [US3] Wire the same planning coordinator into `backend/src/modules/chat/services/workbenchReplayRunner.ts`
- [X] T020 [US3] Add `turn_planning` usage and trace attribution in `backend/src/shared/infra/llm/contextualGateways.ts` and `backend/src/modules/chat/services/turnTraceModelCalls.ts`

## Phase 5: Documentation and verification

- [X] T021 [P] Document standard runtime behavior in `readme.md`
- [X] T022 [P] Update module briefs in `backend/src/modules/chat/README.md` and `backend/src/modules/directives/README.md`
- [X] T023 [P] Update architecture and usage docs in `docs/architecture/assistant-turn-spine.md` and `docs/architecture/usage-event-taxonomy.md`
- [X] T024 [P] Add verification instructions in `specs/102-fused-turn-planning/quickstart.md`
- [X] T025 Run focused tests and builds from `specs/102-fused-turn-planning/quickstart.md`
- [X] T026 Run `pnpm run ci:local -- origin/main` from the repository root (one
  all-buckets run passed; the post-review rerun passed every backend bucket and
  stopped on the unrelated nondeterministic `usage-trends` Playwright layout
  assertion, which passed immediately in isolation)
- [X] T027 Run live evals and review conversation quality across planned and
  staged-fallback turns (repeat: 10/12, with the same two pre-existing routine
  misses; one prior sample had a transient zero-chunk retrieval miss)
- [X] T028 Complete senior-engineer and engineering-manager review gates

## Dependencies

US1 establishes the optimization and owning-module seams. US2 depends on US1's
single-outcome adapters. US3 depends on the same composition but is independently
verifiable through workbench replay after US1 is complete.

## Delivery Strategy

The mergeable unit includes all three stories because fallback safety and replay
parity are required to ship the P1 optimization. Validation and review tasks are
the only remaining work.
