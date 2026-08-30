# US3 Backend Tasks

- [X] T001 [US3] Add failing proposal behavior tests in `backend/tests/unit/operatorCopilot/`
- [X] T002 [US3] Add proposal migration, handwritten Kysely schema type, and repository mapping in `backend/src/db/`
- [X] T003 [US3] Add copilot proposal contracts, services, and draft-only tools in `backend/src/modules/operatorCopilot/`
- [X] T004 [US3] Implement directive and agent-setting adapters through public module surfaces in `backend/src/app/composition/`
- [X] T005 [US3] Wire proposal adapters in `backend/src/app/server/dependencies.ts` and `backend/tests/support/testApp.ts`
- [X] T006 [US3] Add proposal routes and OpenAPI registration in `backend/src/modules/operatorCopilot/routes.ts` and `backend/src/app/http/openapi/paths/copilotPaths.ts`
- [X] T007 [US3] Update catalog coverage and copilot prompt in `backend/src/modules/operatorCopilot/catalogCoverage.ts` and `backend/prompts/copilot/system.md`
- [X] T008 [US3] Run focused Vitest files and `scripts/validate-architecture-boundaries.mjs`; record results in `.context/terra-us3-report.md`

## US1/US2 Reader Completion Slice

- [X] T009 [US1] Add failing agent discovery, projected configuration, directive redaction, and entity-link tests in `backend/tests/unit/operatorCopilot/copilot-us1-tools.test.ts`
- [X] T010 [US2] Add failing routine list/detail portable-document and entity-link tests in `backend/tests/unit/operatorCopilot/copilot-us1-tools.test.ts`
- [X] T011 [US1] Complete `agent_configuration` through public agent list/resolve services and `serializeAgentConfig` in `backend/src/modules/operatorCopilot/tools.ts`
- [X] T012 [US2] Complete routine list/detail behavior through the public routine service and portable projection in `backend/src/modules/operatorCopilot/tools.ts`
- [X] T013 [US1] Update catalog dependency typing and existing focused fixtures in `backend/src/app/composition/copilotToolCatalog.ts` and `backend/tests/unit/operatorCopilot/copilot-us2-tools.test.ts`
- [X] T014 [US2] Update Ray operator guidance in `docs-portal/content/operators/copilot.mdx`
- [X] T015 Run focused operator-copilot tests, backend build/type validation, architecture checks, and record results in `.context/ray-existing-skills.md`
- [X] T016 [US1] Add a non-mutating persisted-agent discovery method and prove the empty-workspace path performs no bootstrap writes
- [X] T017 [US1] Separate agent discovery from detail reads and expose stable directive references for update proposals
- [X] T018 [US2] Preserve routine identity, project unsupported routines as diagnostics, and use explicit list/content bounds without truncating Markdown
- [X] T019 [US1] [US2] Add review-driven regression coverage for nonportable routines, large routine definitions, list bounds, and existing directive proposal targets
- [X] T020 [US1] Add explicit agent list/detail selection plus bounded directive discovery and targeted full directive reads
- [X] T021 [US1] Add explicit targeted-directive metadata, collection, and total-result budgets and correct list activity entity linking
- [X] T022 [US1] Expose bounded built-in answer directives so list-directive catalog coverage includes both authored and platform rules

### Dependencies

- T009 and T010 are the red phase and must complete before T011 and T012.
- T011 and T012 may be implemented independently after their corresponding
  failing tests; T013 integrates both into catalog typing.
- T014 follows the final behavior; T015 gates review and delivery.
- T016-T019 are senior-review remediations and must pass before T015 and the
  second review pass.

### Independent Test Criteria

- US1: without an agent in page context Ray returns a safe workspace agent list;
  with a selected or explicit agent it returns the redacted `AgentConfig`,
  including authored directives, without raw surface tokens.
- US2: without a routine id Ray returns bounded routine identities and
  portability metadata for the selected agent; with a routine id it returns
  the complete portable document when it fits the explicit content budget, or
  an omission reason/diagnostics without returning corrupted Markdown.

## Wave 3 Knowledge-Base Ownership Slice

- [X] T023 [US2] Amend the approved scope, boundaries, queue/SDK impact review, observability decision, and #1051 interim in `specs/104-in-product-operator-copilot/spec.md` and `plan.md`
- [X] T024 [US2] Add failing range/full-text and reprocess/recrawl descriptor tests in `backend/tests/unit/operatorCopilot/copilot-documents-tools.test.ts`
- [X] T025 [US2] Add failing stored-source validation and bounded recrawl tests in `backend/tests/unit/document-source-recrawl-service.test.ts`
- [X] T026 [US2] Implement the Documents-owned recrawl application service and delegate the REST route in `backend/src/modules/documents/services/documentSourceRecrawlService.ts` and `backend/src/app/http/routes/documentRoutes.ts`
- [X] T027 [US2] Implement paged chunk inspection plus document/source reprocess and source recrawl acts through consumer ports in `backend/src/modules/operatorCopilot/tools/documents.ts`
- [X] T028 [US2] Wire the new document ports and update descriptor assembly, capability provenance, owning primitives, and catalog coverage in `backend/src/app/composition/copilotToolCatalog.ts`, `backend/src/app/server/`, and `backend/tests/unit/operatorCopilot/`
- [X] T029 [US2] Update Ray capability guidance and deterministic behavior coverage in `docs-portal/content/operators/copilot.mdx` and `backend/tests/fixtures/copilot-evals/`
- [X] T030 Run focused backend tests, build and architecture checks; complete senior/manager review, record the #1051 decision, refresh #1036 checkboxes, and prepare the pull request

### Dependencies And Independent Test Criteria

- T024 and T025 are the red phase and precede all production code in T026-T028.
- T026 and T027 operate on disjoint owners after their tests fail; T028 assembles
  them only after both behaviors exist. T029 follows the final catalog shape.
- US2 is independently complete when a bounded chunk range returns full text
  and evidence metadata without compaction; document/source maintenance acts
  use workspace-scoped owner paths with manage permission; recrawl cannot
  accept a new URL; and no agent-inaccurate retrieval probe enters the catalog.
