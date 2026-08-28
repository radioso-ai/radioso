# Tasks: Ray Capability and Authorization Boundary

**Input**: `spec.md`, `plan.md`, and the approved requirements checklist.
**Tests**: Backend TDD is mandatory. Each listed backend test is written and observed failing before its implementation task.

## Phase 1: Setup and Design Record

**Purpose**: Establish an executable delivery record without changing authority or contracts.

- [X] T001 Record the feature brief, operation/descriptor inventory, and queue-impact conclusion (no worker/AMQP/retry change) in `.context/1105-ray-capability-boundary.md` and `specs/1105-ray-capability-boundary/plan.md`.
- [X] T002 Run the focused baseline suites and record red/green commands in `specs/1105-ray-capability-boundary/tasks.md` (2026-08-28: `pnpm exec vitest run tests/unit/operatorCopilot/copilot-catalog.test.ts tests/unit/operatorCopilot/copilot-proposals.test.ts` → 58 passing; `pnpm run build` → passing; SDK 27 and MCP 67 tests passing).

## Phase 2: Foundational Capability Governance

**Purpose**: Build the shared machine-checkable vocabulary required by every story. No story work starts until this is complete.

- [X] T003 Write failing provenance-registry, unknown operation, unknown primitive, duplicate/conflict, and reviewed-Ray-only-disposition tests in `backend/tests/unit/operatorCopilot/copilot-catalog.test.ts` and `backend/tests/unit/operatorCopilot/copilot-catalog-shape.test.ts`.
- [X] T004 Write failing current-entitlement and exhaustive role/permission-vector matrix tests in `backend/tests/unit/operatorCopilot/copilot-catalog-shape.test.ts`.
- [X] T005 Implement typed descriptor provenance, reviewed Ray-only dispositions, all-of permission semantics, and catalog governance in `backend/src/modules/operatorCopilot/{catalog,contracts,capabilityProvenance}.ts`.
- [X] T006 Implement the machine-checkable public-operation and owner-module primitive identity registries in `backend/src/app/http/openapi/openApiDocument.ts` and `backend/src/modules/operatorCopilot/applicationPrimitiveRegistry.ts`.
- [X] T007 Wire only the registries and production catalog dependencies in `backend/src/app/composition/copilotToolCatalog.ts`; preserve its construction-only responsibility.
- [X] T008 Run focused provenance and exhaustive-matrix tests in `backend/tests/unit/operatorCopilot/{copilot-catalog,copilot-catalog-shape}.test.ts`.

**Checkpoint**: The assembled production catalog has enforceable provenance and a reusable current-permission gate.

## Phase 3: User Story 1 — Preserve Operator Least Privilege (Priority: P1)

**Goal**: Ray never exposes or produces protected data/effects outside the operator's current ordinary workspace permissions.

**Independent Test**: Every supported role and relevant permission vector can assemble/invoke every production descriptor; revocation before protected reads, proposal creation, invocation, and apply is denied safely without leaked output or domain mutation.

- [X] T009 [US1] Write failing stale-permission tests for catalog assembly, entity resolution, invocation, and pending-proposal application in `backend/tests/unit/operatorCopilot/{copilot-catalog,copilot-proposals}.test.ts`.
- [X] T010 [US1] Write failing composition/per-source authorization and content-free denial-audit tests in `backend/tests/unit/operatorCopilot/{copilot-triage-tools,copilot-proposals}.test.ts`.
- [X] T011 [US1] Implement a current-entitlement gate and invoke it before every protected descriptor hook/effect and proposal apply in `backend/src/modules/operatorCopilot/{service,catalog}.ts`.
- [X] T012 [US1] Apply the gate before descriptor execution and per-source triage reads, preserving unauthorized source status in `backend/src/modules/operatorCopilot/tools/triage.ts`.
- [X] T013 [US1] Keep proposal application delegated to owner services after fresh authorization and preserve content-free audit/telemetry in `backend/src/modules/operatorCopilot/service.ts`.
- [X] T014 [US1] Align deterministic ordinary and Ray routine validation to agent-read authority in `backend/src/app/http/routes/agentRoutes.ts` and `backend/src/modules/operatorCopilot/tools/routines.ts`, with a contract test that stubs an operator granted `workspace.agents.read` and denied `workspace.agents.manage` without changing production role rights.
- [X] T015 [US1] Run the focused authorization, proposal, triage, and routine suites from `backend/tests/unit/operatorCopilot/` and `backend/tests/unit/routines/` (2026-08-28: 346 backend focused/contract tests passing).

## Phase 4: User Story 2 — Accountable Capability Provenance (Priority: P1)

**Goal**: Reviewers can prove every Ray tool has valid ordinary backing or an explicit, justified Ray-only disposition.

**Independent Test**: Production catalog governance rejects stale descriptor/operation/primitive coverage and permission weakening; composed/Ray-only cases validate only with complete declarations.

- [X] T016 [US2] Write forward/reverse coverage tests, including `eval_results`, `turn_trace`, `replay_eval_case`, `test_agent_turn`, `workspace_triage`, proposals, and safe-test orchestration in `backend/tests/unit/operatorCopilot/{copilot-catalog,copilot-catalog-shape,copilot-catalog-coverage}.test.ts`.
- [X] T017 [US2] Declare backing operation identities, owner primitives, permission behavior, and Ray-only dispositions/reasons for every production descriptor in `backend/src/modules/operatorCopilot/{capabilityProvenance,applicationPrimitiveRegistry}.ts`.
- [X] T018 [US2] Implement exhaustive forward public-operation coverage/exclusions and reverse-catalog validation against generated operation identities in `backend/src/modules/operatorCopilot/capabilityProvenance.ts` and `backend/tests/unit/operatorCopilot/copilot-catalog-coverage.test.ts`.
- [X] T019 [US2] Run the Operator Copilot unit suite and OpenAPI contract suite.

## Phase 5: User Story 3 — Owner-Module Boundaries (Priority: P2)

**Goal**: Ray orchestrates via narrow owner ports and never turns composition or repositories into a second domain authority.

**Independent Test**: Architecture tests reject direct Copilot dependencies on protected repositories and proposal behavior continues through owning application services.

- [X] T020 [US3] Write focused narrow-port and prohibited-dependency architecture tests in `backend/tests/unit/operatorCopilot/agent-turn-probe-service.test.ts` and the existing owner-port suites.
- [X] T021 [US3] Expose/use semantic chat conversation identity/probe ports in `backend/src/modules/operatorCopilot/{contracts/agentTurnProbe,services/agentTurnProbeService}.ts`.
- [X] T022 [US3] Expose/use the shared documents source-query boundary for REST and Ray in `backend/src/modules/documents/services/documentIngestionService.ts`, `backend/src/app/http/routes/documentRoutes.ts`, and Ray document/triage dependencies.
- [X] T023 [US3] Reuse existing routine-state and embedding-coverage ports; isolate Ray-specific repository dependency behind owner contracts in `backend/src/app/server/dependencies.ts` and `backend/src/modules/operatorCopilot/contracts/agentTurnProbe.ts`.
- [X] T024 [US3] Keep routine lifecycle and mutation in the routine service, record proposal-only conditional guards as Ray safety, and move proposal policy from composition to `backend/src/modules/operatorCopilot/proposalAdapters.ts`.
- [X] T025 [US3] Run focused owner-port tests and `cd backend && pnpm run lint:boundaries`.

## Phase 6: User Story 4 — Truthful Public Contracts (Priority: P2)

**Goal**: All live eval operations and Ray stateful behavior are represented consistently across generated contracts.

**Independent Test**: Every live eval route has one OpenAPI operation identity; contract generation, SDK snapshot, and MCP checks agree.

- [X] T026 [US4] Write route-to-OpenAPI completeness and Ray turn mutation-description tests in `backend/tests/contract/openapi.contract.test.ts`.
- [X] T027 [US4] Register every live operator eval route with accurate schemas/authorization/unique operation IDs and correct the Ray turn description in `backend/src/app/http/openapi/paths/{evalPaths,copilotPaths}.ts`.
- [X] T028 [US4] Regenerate backend OpenAPI outputs through `backend/scripts/generateOpenApi.ts`, then sync generated SDK and MCP snapshots.
- [X] T029 [US4] Run backend contract tests, API-contract checks, TypeScript SDK build/tests, and MCP build/tests; queue impact remains unaffected as recorded in `specs/1105-ray-capability-boundary/plan.md`.

## Phase 7: Polish, Documentation, and Handoffs

- [X] T030 Update the durable capability-boundary, Ray-only orchestration, current authorization, proposal-guard, and standalone-MCP non-inference documentation in `docs/architecture/code-map.md` and `docs-portal/content/operators/copilot.mdx` after reading `docs/document-writer-prompt.md`.
- [X] T031 Run deterministic Ray behavior checks (`cd backend && pnpm exec vitest run tests/unit/operatorCopilot/copilot-eval-suite.test.ts`) and the complete focused backend suite; live eval remains an on-demand Postgres/`OPENAI_API_KEY` check and was not treated as passed.
- [X] T032 Re-run `pnpm run ci:local -- origin/main` after the feature is committed, inspect `git diff --check`, reconcile all FR/SC items against `specs/1105-ray-capability-boundary/spec.md`, and update task checkboxes in this file. (2026-08-28: two committed-diff CI attempts passed bootstrap, build, schema/type checks, boundary lint, and all 4,664 unit tests; each integration run passed 859/860 and failed a different unrelated route-bootstrap test that passed immediately in isolation. The contract suite showed the same known route-registration interference; affected files/tests passed in isolation. Downstream frontend lint/unit/E2E, docs lint/build, SDK, MCP smoke, crawler, census, and EE checks passed; one EE socket hang-up passed 19/19 on isolated rerun. `git diff --check` is clean.)
- [X] T033 Obtain follow-up senior-engineer and engineering-manager acceptance after the final authorization corrections, then prepare the branch for PR creation with validation evidence in the PR body. Live eval remains an on-demand Postgres/`OPENAI_API_KEY` gate. (2026-08-28: Terra senior-engineer corrections completed; primary engineering-manager acceptance reran 320 backend tests, SDK 27, MCP 67, boundary lint, runtime typecheck, generated-contract checks, and `git diff --check` successfully.)

## Dependencies & Execution Order

- Phase 2 blocks every user story; its registries and authorization gate are the shared foundation.
- US1 and US2 then proceed together, but final descriptor declarations depend on the governance vocabulary.
- US3 owner ports may proceed after Phase 2 and must complete before catalog wiring is finalized.
- US4 depends on stable public-operation identities and must complete before generated snapshots.
- Polish follows all stories. No frontend change is planned.

## Implementation Strategy

1. Establish capability vocabulary and red-green governance checks.
2. Enforce current authorization before every descriptor-owned protected read/effect, then prove exhaustive least privilege.
3. Declare and validate every descriptor's ordinary backing or reviewed Ray-only provenance.
4. Repair owner ports and composition seams before contract/snapshot regeneration.
5. Finish docs, deterministic behavior tests, CI, peer review, manager pass, and only then create a PR.
