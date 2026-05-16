# Tasks: Enterprise Human Contact Handoff

**Input**: Design documents from `/specs/056-enterprise-human-contact-handoff/`  
**Prerequisites**: plan.md, spec.md

## Phase 1: Setup

- [x] T001 Create approved feature spec, checklist, plan, and tasks artifacts.
- [x] T002 Inspect existing backend, frontend, embed, and EE extension seams.

## Phase 2: Backend Foundation

- [x] T003 Add backend tests for OSS text suggestion typing without EE-specific action names.
- [x] T004 Add shared chat-intake provider contracts, disabled implementation, and error mapping.
- [x] T005 Wire default no-op chat-intake provider through composition.
- [x] T006 Update assistant/public chat response contracts and OpenAPI registry for intake metadata.

## Phase 3: Enterprise Backend

- [x] T007 Add EE migration for contact settings and requests/outbox rows.
- [x] T008 Add EE tests for settings save/readback/rotation and request persistence.
- [x] T009 Implement EE settings repository/service with masked secret readback.
- [x] T010 Add EE tests for draft, submit, webhook signing, retry, and terminal failure.
- [x] T011 Implement EE draft, submit, webhook payload/signing, and retry poller services.
- [x] T012 Register EE routes, migrator, and worker lifecycle from `ee/packages/backend-module`.

## Phase 4: Frontend And Embed

- [x] T013 Keep OSS frontend API helpers/types generic; contact settings are EE-owned routes.
- [x] T014 Add contact-human chat intake with loading, validation, success, and failure states.
- [x] T015 Wire dashboard chat through the server-side intake without an inline composer.
- [x] T016 Wire public chat and embed through the server-side intake responsively.
- [x] T017 Add Enterprise settings controls for enablement, webhook URL, masked secret, and rotation.
- [x] T018 Add focused frontend tests for settings and chat behavior where existing harness supports it.
- [x] T023 Amend the spec for the skill-intake handoff and visible explicit-contact intent behavior.
- [x] T024 Enact explicit typed contact requests through the human-contact skill intake when contact delivery is configured.
- [x] T025 Add contact requests to Activity list/detail through an EE-backed history provider.
- [x] T026 Rename the admin/chat surface to Talk to a human, add email delivery settings, and use reveal/copy/rotate signing-token controls for webhook delivery.

## Phase 5: Docs, SDK, Validation

- [x] T019 Read `docs/document-writer-prompt.md` and update relevant docs.
- [x] T020 Regenerate backend OpenAPI and SDK contract artifacts.
- [x] T021 Run targeted backend, frontend, EE, and docs validation.
- [x] T022 Re-read spec/plan/tasks and changed code for scope-fit review.

## Validation Evidence

- `backend`: `npm run build`, `npx vitest run tests/contract/openapi.contract.test.ts tests/contract/sdk-openapi.contract.test.ts`
- `ee`: `npm run build`, `npx vitest run src/humanContact/humanContactService.test.ts`
- `frontend`: `npm run build`, `npm run lint`, `npx vitest run tests/unit/embed-session-storage.test.ts`
- `typescript-sdk`: `npm run build`
- Full backend contract suite was previously attempted with the default timeout and again with `--testTimeout=15000`; both runs timed out in unrelated existing contract tests under workspace load, while the OpenAPI/SDK contract checks passed.
