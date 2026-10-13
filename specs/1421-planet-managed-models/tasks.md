# Tasks: Planet Managed Models

**Input**: Design documents from `/specs/1421-planet-managed-models/`

**Prerequisites**: spec.md, plan.md, research.md

**Tests**: Backend TDD and visible frontend Playwright coverage are mandatory.

## Phase 1: Specification And Discovery

- [X] T001 Create the approved specification and cross-area feature brief.
- [X] T002 Trace provider credential resolution across chat, Ray, retrieval, document workers, embeddings, suggestions, summaries, and direct provider construction.
- [X] T003 Record module boundaries, queue impact, observability, copilot coverage, catalog units, rate expression, and plan-id enumeration findings.

## Phase 2: User Story 1 - Keep BYOK Credentials Tenant-Owned (Priority: P1)

**Goal**: A BYOK plan cannot use deployment credentials for any capability.

**Independent Test**: Resolve chat and embeddings for a BYOK-policy workspace with no workspace key while environment keys exist; both fail with the existing provider-misconfigured shape, while OSS/unrestricted and managed behavior stays intact.

- [X] T004 [US1] Add failing resolver tests in `backend/tests/unit/workspace-llm-capability-resolver.test.ts` and Enterprise policy tests in `ee/packages/backend-module/src/managedModels/managedModelPolicy.test.ts`; run them and record the red result.
- [X] T005 [US1] Replace the ambiguous shared/Enterprise policy result with a single model-and-credential decision in `backend/src/shared/domain/managedModelPolicy.ts`, the resolver, and `ee/packages/backend-module/src/radiosoModuleTypes.ts` / `managedModels/managedModelPolicy.ts`.
- [X] T006 [US1] Update policy mocks/contracts and composition documentation, then run resolver, provider-registry, composition, settings, Ray availability, and Enterprise managed-policy tests.
- [ ] T007 [US1] Commit the BYOK fix and evidence as the first Conventional Commit.

## Phase 3: User Story 2 - Choose Managed Models On Planet (Priority: P1)

**Goal**: Sell a quota-equivalent managed Planet variant at €749/month and €7,490/year.

**Independent Test**: Catalog, checkout, webhook, Stripe sync, upgrade ordering, usage-limit seeds, and the Plan card all recognize and present `planet_managed` through existing generic paths.

- [ ] T008 [US2] Add failing plan-catalog parity/price tests, pricing-order tests, webhook/Stripe-sync assertions, and a Playwright test for the Planet managed-model choice; run them and record the red result.
- [ ] T009 [US2] Add `planet_managed` and its lookup keys to `ee/packages/plan-catalog/src/plans.json` / `index.ts`, make it the self-serve ceiling, and update affected catalog fixtures/enumerations.
- [ ] T010 [US2] Implement catalog-derived Planet plan-card wording/action and update billing, usage-limit, webhook, Stripe-sync, staff/operator-console, analytics, and frontend tests where enumeration audits require explicit coverage.
- [ ] T011 [US2] Read `docs/document-writer-prompt.md`, update `ee/packages/plan-catalog/README.md`, `ee/readme.md`, billing setup and Enterprise pricing/usage docs, then regenerate the product-docs corpus.
- [ ] T012 [US2] If a local Stripe test key exists, run test-mode `stripe:sync` dry-run and apply as appropriate; never pass `--live`. Record the exact owner live command regardless.

## Phase 4: Verification And Delivery

- [ ] T013 Run changed-module tests and all required backend, frontend, Enterprise, ESLint, dead-code, docs, and product-corpus gates; report exact results and pre-existing baselines.
- [ ] T014 Perform a self senior-engineer findings-first review and one self engineering-manager scope/release review because subagent delegation is explicitly prohibited; resolve all in-scope findings.
- [ ] T015 Commit Part 2 as the second Conventional Commit, push `feat/planet-managed-models-1421`, and open a PR with design answers, exact validation, owner live-sync step, `Closes #1421`, and the required footer.

## Dependencies & Execution Order

- T004–T007 are Part 1 and must complete and commit before any Part 2 production change.
- T008 establishes Part 2 red tests before T009–T011 implementation.
- T012 depends on the completed catalog and available local test credentials.
- T013–T015 depend on both parts.

## Parallel Opportunities

The user explicitly requires single-agent execution. Independent test commands may run concurrently, but all discovery, implementation, review, and delivery stay in this session.

## Implementation Strategy

Land the security boundary first as its own reviewable commit. Then add the catalog variant and let existing data-driven consumers absorb it, changing only presentation and tests that need intentional variant behavior.
