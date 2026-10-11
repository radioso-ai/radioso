# Tasks: Notification Email Caps And Hygiene

**Input**: Design documents from `/specs/1464-notification-email-caps/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/delivery-policy.md

**Tests**: Backend TDD is mandatory. Each story's behavior tests are written and observed failing before implementation.

## Phase 1: Setup

- [X] T001 Create approved specification and design artifacts in specs/1464-notification-email-caps/
- [X] T002 Record module boundaries, queue impact, observability, and copilot coverage in specs/1464-notification-email-caps/plan.md and research.md

## Phase 2: Foundational

- [X] T003 Add failing policy/default and plan-catalog allowance tests in backend/tests/unit/usage-limit-policy.test.ts and ee/packages/plan-catalog/tests/planCatalog.test.ts
- [X] T004 Add the plan allowance field and OSS/EE limit resolvers in backend/src/shared/domain/usageLimitPolicy.ts, ee/packages/plan-catalog/src/, and ee/packages/backend-module/src/usageLimits/
- [X] T005 Add failing delivery-outcome repository integration tests in backend/tests/integration/notification-delivery-outcome-repository.integration.test.ts
- [X] T006 Add the OSS outcome migration, generated snapshots, repository adapter, and domain admission guard in backend/src/db/ and backend/src/modules/operatorNotifications/

## Phase 3: User Story 1 - Bound Outbound Volume (Priority: P1)

**Goal**: Enforce workspace/day email and conversation dispatch caps with visible safe outcomes.

**Independent Test**: Concurrent unique requests cannot exceed either cap, and retries reuse the original decision.

- [X] T007 [US1] Add failing contact-handler and operator-sink cap behavior tests in backend/tests/unit/contact-send-action-handler.test.ts and backend/tests/unit/operator-notifications/email-webhook-sink.test.ts
- [X] T008 [US1] Inject the shared admission guard through backend/src/app/composition/applicationModule.ts, backend/src/app/server/builders/chat.ts, and backend/src/app/composition/builtIn/contactRoutineModule.ts
- [X] T009 [US1] Enforce guard decisions and safe skip logging/audit in backend/src/modules/chat/services/actions/contactSendActionHandler.ts and emailWebhookSink.ts

## Phase 4: User Story 2 - Restrict And Audit Recipients (Priority: P1)

**Goal**: Preserve ordinary member authoring but restrict recipient-list changes to owner/admin and audit safe deltas.

**Independent Test**: Member recipient changes fail across REST/Ray/MCP, admin changes succeed, unrelated changes remain allowed, and audit metadata has only hashes/counts.

- [X] T010 [US2] Add failing account permission, route, service audit, and operator-tool authorization tests in backend/tests/unit/
- [X] T011 [US2] Add `workspace.notification_recipients.manage` and conditional HTTP checks in backend/src/modules/account/ and backend/src/app/http/routes/
- [X] T012 [US2] Add shared safe recipient audit projection and service audit calls in backend/src/modules/agents/ and backend/src/modules/agentSkills/
- [X] T013 [US2] Apply conditional authorization at reviewed execution in backend/src/modules/operatorCopilot/ while leaving non-mutating proposal drafting available

## Phase 5: User Story 3 - Sanitize Delivery Inputs (Priority: P1)

**Goal**: Bound visitor content, validate reply-to, tag mail, and sign contact/notice webhooks.

**Independent Test**: Oversized input truncates, invalid reply-to is absent, mail kinds are stable, and signatures verify.

- [X] T014 [US3] Add failing hygiene tests in backend/tests/unit/contact-send-action-handler.test.ts, backend/tests/unit/operator-notifications/email-webhook-sink.test.ts, and backend/tests/unit/operator-notifications/routine-ending-notification-from-action.test.ts
- [X] T015 [US3] Implement shared visitor notification text/email normalization in backend/src/modules/operatorNotifications/ and apply it to contact and routine-notice parsing/rendering
- [X] T016 [US3] Extend EmailKind and transport ports, tag contact/notice mail, and sign webhooks with createSignedWebhookHeaders in backend/src/modules/mail/ and backend/src/modules/chat/services/actions/

## Phase 6: Documentation And Verification

- [X] T017 Update docs-portal/content/api/agents-and-skills.mdx, docs-portal/content/guides/authoring-routines.mdx, and docs/operator-mcp.md after reading docs/document-writer-prompt.md
- [X] T018 Regenerate packages/product-docs/src/generated/corpus.json and database schema/type snapshots
- [X] T019 Run all focused tests for changed modules plus backend runtime/full typechecks, backend lint, frontend typecheck if touched, EE build/tests, root ESLint, and dead-code ratchet
- [X] T020 Perform self senior review and engineering-manager scope/release review; resolve all blocking findings
- [X] T021 Commit, push fix/notification-email-caps-1464, and open a PR with exact validation results, follow-up scope, `Refs #1464`, and the required generation footer

## Dependencies & Execution Order

- T003–T006 establish the shared policy/persistence foundation.
- T007–T009 depend on T004 and T006.
- T010–T013 are independent of delivery admission after the shared specification.
- T014–T016 can proceed after transport seams are understood and before documentation.
- T017–T021 depend on all behavior phases.

## Parallel Opportunities

The user explicitly requires single-agent execution. Tests in independent files may be run concurrently, but implementation remains sequential in this workspace.

## Implementation Strategy

Deliver the security boundary as one mergeable slice: durable caps first, then authoring restriction/audit, then transport hygiene, documentation, and full verification. Do not include confirmation state or Resend suppression.
