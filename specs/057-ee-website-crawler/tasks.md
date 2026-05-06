# Tasks: Enterprise Website Crawler Provider

**Input**: Design documents from `/specs/057-ee-website-crawler/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Backend tests are REQUIRED and MUST appear before implementation tasks.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish Enterprise crawler module files and documentation artifacts.

- [x] T001 Create Enterprise website crawler module directory in `ee/packages/backend-module/src/websiteCrawler/`
- [x] T002 [P] Add design contract notes in `specs/057-ee-website-crawler/contracts/ee-website-crawler.md`
- [x] T003 [P] Confirm no frontend files are needed for this feature in `specs/057-ee-website-crawler/plan.md`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Enterprise-owned provider types and safe error primitives used by all stories.

- [x] T004 [P] Write provider boundary tests through `ee/packages/backend-module/src/websiteCrawler/config.test.ts`, `ee/packages/backend-module/src/websiteCrawler/routes.test.ts`, and `ee/packages/backend-module/src/websiteCrawler/service.test.ts`
- [x] T005 [P] Write safe error behavior tests in `ee/packages/backend-module/src/websiteCrawler/errors.test.ts`
- [x] T006 Implement provider contract types in `ee/packages/backend-module/src/websiteCrawler/provider.ts`
- [x] T007 Implement crawler error classes in `ee/packages/backend-module/src/websiteCrawler/errors.ts`

**Checkpoint**: Foundation ready - user story implementation can now begin.

---

## Phase 3: User Story 1 - Configure Enterprise Crawling (Priority: P1) 🎯 MVP

**Goal**: Enterprise can configure or disable crawler provider behavior without OSS crawler concepts.

**Independent Test**: Load Enterprise config with enabled/disabled values and verify OSS composition remains crawler-agnostic.

### Tests for User Story 1

- [x] T008 [P] [US1] Write crawler config tests in `ee/packages/backend-module/src/websiteCrawler/config.test.ts`
- [x] T009 [P] [US1] Verify existing OSS composition tests remain crawler-agnostic in `backend/tests/unit/default-composition.test.ts`

### Implementation for User Story 1

- [x] T010 [US1] Implement Enterprise crawler limit config resolver in `ee/packages/backend-module/src/websiteCrawler/config.ts`
- [x] T011 [US1] Export crawler provider port through `ee/packages/backend-module/src/websiteCrawler/provider.ts`
- [x] T012 [US1] Verify no crawler-specific registration API is added to `backend/src/app/composition/applicationModule.ts`

**Checkpoint**: User Story 1 is independently testable.

---

## Phase 4: User Story 2 - Crawl A Website Into Workspace Documents (Priority: P2)

**Goal**: Enterprise service maps provider pages into existing document ingestion with stable external document IDs.

**Independent Test**: Fake provider returns pages and fake document ingestion records the expected idempotent writes.

### Tests for User Story 2

- [x] T013 [P] [US2] Write publication service tests in `ee/packages/backend-module/src/websiteCrawler/service.test.ts`
- [x] T014 [P] [US2] Write fake-provider publication tests in `ee/packages/backend-module/src/websiteCrawler/service.test.ts`

### Implementation for User Story 2

- [x] T015 [US2] Implement provider-agnostic Enterprise module composition hook in `ee/packages/backend-module/src/index.ts`
- [x] T016 [US2] Implement crawl publication service in `ee/packages/backend-module/src/websiteCrawler/service.ts`
- [x] T017 [US2] Ensure document metadata includes website source fields in `ee/packages/backend-module/src/websiteCrawler/service.ts`

**Checkpoint**: User Story 2 is independently testable.

---

## Phase 5: User Story 3 - Surface Provider Failures Safely (Priority: P3)

**Goal**: Enterprise route exposes clear unavailable, failed, partial-success, and validation behavior without leaking secrets.

**Independent Test**: Supertest route coverage with disabled config, provider failures, and partial document ingestion failures.

### Tests for User Story 3

- [x] T018 [P] [US3] Write Enterprise crawler route tests in `ee/packages/backend-module/src/websiteCrawler/routes.test.ts`

### Implementation for User Story 3

- [x] T019 [US3] Implement Enterprise crawler routes in `ee/packages/backend-module/src/websiteCrawler/routes.ts`
- [x] T020 [US3] Register Enterprise crawler route mount in `ee/packages/backend-module/src/index.ts`
- [x] T021 [US3] Extend Enterprise route dependency types for document ingestion only as needed in `ee/packages/backend-module/src/radiosoModuleTypes.ts`

**Checkpoint**: All user stories are independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, config, validation, and review readiness.

- [x] T022 [P] Update Enterprise crawler settings in `.env.example`
- [x] T023 [P] Update Enterprise crawler documentation in `ee/readme.md`
- [x] T024 Run `npm test -- --run packages/backend-module/src/websiteCrawler` from `ee/`
- [x] T025 Run `npm run build` from `ee/`
- [x] T026 Run `npm test -- --run tests/unit/default-composition.test.ts` from `backend/`
- [x] T027 Record message-queue impact review result in `specs/057-ee-website-crawler/plan.md`
- [x] T028 Address code-review hardening for public URL policy, workspace selection, startup config validation, and safe publication failures
- [x] T029 Address code-review hardening for local page caps, pre-crawl abuse control, and per-page malformed URL accounting
- [x] T030 Address code-review hardening for abstract-provider scope and IPv4-mapped IPv6 private address blocking
- [x] T031 Address code-review hardening for route-local limit config failures, provider error normalization, trusted metadata precedence, and generic secret redaction
- [x] T032 Address code-review hardening for credential-bearing URL rejection, recursive secret redaction, provider result validation, provider-failure audit events, and local wrapper-module quickstart
- [x] T033 Address code-review hardening for provider source URL credential handling, nested sensitive-key redaction, invalid page failure accounting, and file URL module quickstart
- [x] T034 Address code-review hardening for provider identifier redaction, pre-normalization local page caps, and bearer-token route auth
- [x] T035 Address code-review hardening for provider failure userinfo redaction, stale-cookie bearer fallback, special-use IPv4 blocking, query preservation, and focused quickstart test command
- [x] T036 Address code-review hardening for provider cancellation signals and special-use IPv6 blocking

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies.
- **Foundational (Phase 2)**: Depends on Setup completion and blocks all user stories.
- **User Story 1 (Phase 3)**: Depends on Foundational.
- **User Story 2 (Phase 4)**: Depends on Foundational.
- **User Story 3 (Phase 5)**: Depends on User Story 2 service and User Story 1 config.
- **Polish (Phase 6)**: Depends on desired user stories being complete.

### Parallel Opportunities

- T002 and T003 can run in parallel.
- T004 and T005 can run in parallel.
- T008 and T009 can run in parallel.
- T013 and T014 can run in parallel.
- T022 and T023 can run in parallel.

## Implementation Strategy

1. Build the Enterprise provider/config foundation first.
2. Validate the EE-only boundary before adding route behavior.
3. Add provider-to-document publication as the core product value.
4. Add route transport last and keep it thin.
5. Finish with docs, config, and validation.
