# Tasks: Unified Skill Model

**Input**: Design documents from `/specs/094-unified-skills/`
**Prerequisites**: spec.md, research.md, plan.md, data-model.md, quickstart.md

**Tests**: Backend is TDD — tests written and FAILING before implementation. Frontend user-visible journeys use Playwright; frontend unit tests cover only non-visual logic (capability descriptor → form derivation, validation).

**Conventions**: run one backend test file with `pnpm exec vitest run <path>` (`pnpm test -- <path>` runs the whole suite). Regenerate OpenAPI via the code-first registry (`backend/src/app/http/openapi/document.ts` → regen script); never hand-edit `backend/openapi.yaml`/`.json`. Do NOT run `pnpm run build` inside a sandboxed agent (dist EPERM hang) — verify with `tsc --noEmit` + vitest. Run `pnpm run ci:local -- origin/main` before each PR. Each phase is an independently shippable PR; behavior-preserving slices ship with regression proof before the new ability is exposed.

**Labels**: `[P]` parallelizable (different files, no dep) · `[F0]` foundational keystone · `[US1..US4]` user stories.

---

## Phase F0: Capability registry + spine extension + unified API ⚠️ BLOCKS all user stories

**Goal**: One capability-type registry, the `agent_skills` spine extended with `invocation_mode`, and one CRUD + `skill-capabilities` API over the **existing four kinds** — no runtime behavior change.

**Independent Test**: `GET /skill-capabilities` projects the registry; `GET/POST/PATCH/DELETE /agents/{id}/skills` round-trip the four existing kinds on the spine; existing routine→skill dispatch unchanged; legacy per-kind suites green.

- [ ] T001 [F0] Blast-radius scan: list every reference to the per-kind skill routes/adapters/types (`external-skills`, `customer-email-skills`, `slack-skills`, `webhook` skill endpoints) across backend routes, OpenAPI, SDK, MCP, frontend adapters, tests. Record here before edits.
- [ ] T002 [F0] Migration: add `agent_skills.invocation_mode` (CHECK in default_answer/routine_named/agent_selectable); backfill existing rows to `routine_named`; extend `kind` CHECK with `retrieve`,`notify`; add partial unique index `agent_skills_one_default_answer (agent_id) WHERE invocation_mode='default_answer'`.
- [ ] T003 [P][F0] Tests FIRST: capability-type registry unit tests — descriptor lookup, kind↔capability-id mapping, supported-invocation-mode enforcement, `validateConfig` per capability.
- [ ] T004 [F0] Implement `backend/src/modules/skills/capabilityRegistry.ts` + `capabilities/{mcpTool,email,slackPost,webhookCall}.ts` descriptors (targetKind, inputSchema source, outcomeVocabulary, supportedModes, executorAdapter, validateConfig). Map stored kinds ↔ capability ids.
- [ ] T005 [F0] Composition: register the registry + bind each capability's `executorAdapter` to the existing `SkillExecutorRegistry` in `backend/src/app/composition/` (mirror current executor wiring); cleanly degrade when a capability's connection type is absent.
- [ ] T006 [P][F0] Tests FIRST: uniform spine skill repository facade — read/write any kind via one interface (over existing per-kind repos or a single `agent_skills` repo), preserving each kind's config shape.
- [ ] T007 [F0] Implement the uniform skill repository facade; existing per-kind repositories delegate to / are subsumed by it without changing their config mapping.
- [ ] T008 [P][F0] Tests FIRST: `agentSkills` CRUD service — create/update/delete/list capability-neutral; name uniqueness + identifier validation; (capability, invocation_mode) gate; single default-answer gate.
- [ ] T009 [F0] Implement `agentSkills` CRUD service (delegates capability specifics to the registry; no per-kind branching).
- [ ] T010 [P][F0] Tests FIRST: contract tests for `GET /agents/{id}/skill-capabilities` (registry projection incl. unavailable-when-no-connection) and `GET/POST/PATCH/DELETE /agents/{id}/skills` (uniform envelope).
- [ ] T011 [F0] Implement the routes; register in `backend/src/app/http/openapi/document.ts`; regenerate OpenAPI. Keep legacy per-kind routes as thin shims delegating to the unified service.
- [ ] T012 [F0] Verify existing routine→skill dispatch + per-kind suites unchanged; `tsc --noEmit` + targeted vitest green.

**Checkpoint**: Unified API + registry exist; the four existing capabilities round-trip; runtime unchanged.

---

## Phase US1: Unified Skills list + Add-skill form [P1] 🎯 MVP

**Goal**: One list + one data-driven form over F0; remove MCP/email/Slack bespoke cards; separate connections from skills.

**Independent Test**: Playwright — open Skills tab, add one skill of each available capability through one form, see it in one list, reference by `@name` in a routine; unavailable capabilities are flagged; the form never edits credentials.

- [ ] T013 [P][US1] Tests FIRST (frontend unit): capability-descriptor → form-field derivation + bound/exposed + invocation-mode + validation logic (non-visual).
- [ ] T014 [US1] Implement `frontend/lib/api-skills.ts` unified adapter (list/create/update/delete + skill-capabilities), replacing `api-external-skills`/`api-customer-email`/`api-slack-skills`.
- [ ] T015 [US1] Implement `frontend/components/dashboard/settings/skills/SkillForm.tsx` (data-driven from descriptor; capability picker → target picker → name → inputs bound/expose → outcomes → invocation mode) + `SkillList.tsx`.
- [ ] T016 [US1] Remove `AssistantExternalSkillsSection`/`AssistantEmailSkillsSection`/`AssistantSlackSkillsSection` from `workspace-assistant-channels-tab.tsx`; mount `SkillList` + Add-skill; tab SHRINKS. Keep connection setup as its own surface/section.
- [ ] T017 [P][US1] Playwright: add-skill journey for each available capability + unavailable-capability state + routine `@name` reference.
- [ ] T018 [US1] Docs: Skills authoring guide (unified "Add new skill"), settings docs, SDK/MCP refs reflecting unified endpoint. `ci:local`.

**Checkpoint**: One Skills surface over the four existing capabilities; three cards/adapters retired.

---

## Phase US2: Retrieval as a named skill capability [P2] (keystone data-model change)

**Goal**: retrieval onto the spine as named instances; grounding answer = `default_answer` instance (behavior-preserving); `@retrieve_events`.

**Independent Test**: migrate an agent; verify one `default_answer` retrieve skill carries the same config and grounded answers are unchanged (eval 0 diffs); add `@retrieve_events` scoped to a dataset + instruction, invoke from a routine, get in-scope results + structured outcome.

- [ ] T019 [P][US2] Tests FIRST: retrieve capability descriptor (`validateConfig`, sourceScope, instruction, tuning fields; `similarityThreshold` rejected as system-only) + supported modes (all three).
- [ ] T020 [US2] Implement `modules/skills/capabilities/retrieve.ts` descriptor + retrieve config schema in `modules/retrieval`.
- [ ] T021 [P][US2] Tests FIRST: migration — each agent's `skill_settings['retrieval.answer']` + behavior retrieval fields → one `retrieve` row (`default_answer`), enabled = retrievalEnabled, scope/instruction/tuning in config; idempotent + reversible-by-shape.
- [ ] T022 [US2] Migration script (data) + read-path switch: default-answer turn resolves the spine row (workspace-default inheritance preserved); `skill_settings['retrieval.answer']` retired as source of truth.
- [ ] T023 [P][US2] Tests FIRST: retrieve routine-skill resolver/executor supporting multiple named, source-scoped instances (generalize today's singleton `RetrievalAnswerSkillExecutor`); returns structured found/empty outcome.
- [ ] T024 [US2] Implement the retrieve resolver/executor; wire into `skillDispatcher` resolver chain + `SkillExecutorRegistry`.
- [ ] T025 [US2] Regression: grounded-answer eval shows 0 behavioral diffs pre/post migration; targeted vitest + integration green.
- [ ] T026 [US2] Frontend: retrieve capability in the unified form (scope/dataset picker, instruction, tuning, suggested-questions); remove the bespoke Retrieval card. Playwright for `@retrieve_events`.
- [ ] T027 [US2] Docs: retrieval-as-skill + dataset-scoped skills; `ci:local`.

**Checkpoint**: Retrieval is a capability; the headline `@retrieve_events` works; grounding unchanged.

---

## Phase US3: Invocation mode runtime semantics [P2]

**Goal**: enforce and honor invocation mode across selection.

**Independent Test**: three skills, three modes — default-answer runs as implicit answer; routine_named never auto-selected; agent_selectable eligible for autonomous selection; second default-answer rejected.

- [ ] T028 [P][US3] Tests FIRST: turn selection honors invocation_mode (default-answer implicit path; routine_named excluded from autonomous selection; agent_selectable included).
- [ ] T029 [US3] Implement invocation-mode filtering in the skill-selection / default-answer path (no English keyword logic; pure mode field).
- [ ] T030 [P][US3] Tests FIRST + impl: service-level enforcement of single default-answer (unique index + friendly validation error) and unsupported-mode rejection via registry.
- [ ] T031 [US3] Frontend: invocation-mode control in `SkillForm` (only registry-supported modes); Playwright. Docs note. `ci:local`.

**Checkpoint**: Invocation mode is explicit, enforced, and honored at runtime.

---

## Phase US4: Fold notify + webhook_call; remove last cards [P3]

**Goal**: contact→notify, webhook-export→webhook_call; Skills tab has zero bespoke capability cards.

**Independent Test**: migrate contact-enabled agent → notify skill, public-chat affordance preserved + same destinations, disabling hides it; migrate exports-enabled agent → webhook_call skill, routine completion exports exactly once.

- [ ] T032 [P][US4] Tests FIRST: notify capability descriptor + NotifyExecutor (delivery to recipientEmails + optional webhook; structured outcome; no hard-coded copy).
- [ ] T033 [US4] Implement notify capability + executor; register in composition.
- [ ] T034 [P][US4] Tests FIRST: migration contact (`contactRequestsEnabled`+`contactRequestDelivery`) → `notify` skill (`routine_named`), enabled mapping, delivery config; behavior-preserving.
- [ ] T035 [US4] Migration + wire public-chat "contact a human" affordance to the notify skill's enabled state + delivery (same destinations); surface invocation orthogonal to invocation_mode.
- [ ] T036 [P][US4] Tests FIRST: migration webhook-export (`webhookExportsEnabled`) → `webhook_call` skill bound to destination; routine-completion invocation exactly-once (outbox idempotency).
- [ ] T037 [US4] Implement routine-completion webhook_call invocation; remove the standalone "Webhook exports" toggle + "Contact requests" card.
- [ ] T038 [US4] Move suggested-questions into the default-answer retrieve skill config; remove any remaining bespoke capability cards; confirm only agent appearance settings (citations, theme, link UTM) remain. Playwright.
- [ ] T039 [US4] Docs: notify + webhook_call as skills; migration notes; settings docs; SDK/MCP refs. `ci:local`.

**Checkpoint**: Every capability is a skill; the Skills tab is one unified list + appearance settings. SC-006 met.

---

## Cross-cutting (every phase)

- Observability: skill CRUD + capability resolution logs/metrics/traces with identities/counts only — never credentials, message text, retrieved chunks, tokens (FR-020).
- Message-queue review: notify/webhook_call outbox actions + routine→skill dispatch retry/idempotency unchanged where reused.
- OpenAPI regenerated from the code-first registry each time a route changes.
- `pnpm run ci:local -- origin/main` green before each PR; include result in PR body.
