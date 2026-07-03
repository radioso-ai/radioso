# Tasks: Directive Skill Binding

**Input**: Design documents from `/specs/099-directive-skill-binding/`
**Prerequisites**: plan.md, research.md, data-model.md, quickstart.md, approved spec.md

**Note**: Backend TDD is constitutionally mandatory — every implementation task is
preceded by a failing-test task in the same phase. `backend/openapi.yaml`/`.json`,
Kysely db types, and the schema dump are generated artifacts: regenerate, never
hand-edit. Do not run `pnpm run build` during implementation; verify with
`tsc --noEmit` and targeted `pnpm exec vitest run <path>`.

## Phase 1: Setup

*(No setup tasks — branch, spec, and design artifacts already exist; no new tooling.)*

- [ ] T001 Confirm clean baseline: `cd backend && pnpm exec tsc --noEmit` passes and
      `pnpm exec vitest run tests/unit/modules/agents tests/unit/modules/chat` is green
      before any change (record result in PR notes)

## Phase 2: Foundational (blocking all user stories)

- [ ] T002 Write failing unit tests for the authored directive `binding` field
      (accepts `{kind:"skill",skillName}`, rejects unknown kinds, rejects >200-char
      skill names, defaults to null) in backend/tests/unit/modules/agents (beside the
      existing authoredDirectives tests)
- [ ] T003 Add `DirectiveBinding` + `Directive.binding?` to
      packages/conversation-contract/index.d.ts (JSDoc: kind union reserved for future
      `routine`; matcher never reads bindings)
- [ ] T004 Add migration backend/src/db/migrations/119_agent_directive_binding.sql
      (`ALTER TABLE agent_directives ADD COLUMN binding JSONB NULL`), then regenerate
      generated artifacts: `pnpm run db:types` and `pnpm run db:schema` in backend/
- [ ] T005 Implement `binding` in backend/src/modules/agents/authoredDirectives.ts
      (schema + `AUTHORED_DIRECTIVE_LIMITS` entry + `AuthoredDirective` interface) and
      row mapping in backend/src/modules/agents/authoredDirectiveMapper.ts and the
      directives repository (persist/read the JSONB column); T002 tests go green

## Phase 3: User Story 1 — Bind a skill to a directive (P1) 🎯 MVP

**Goal**: authored binding routes matching non-routine turns to the bound skill;
invalid skills rejected at authoring.

**Independent test**: quickstart.md steps 2-4 and 6.

- [ ] T006 [P] [US1] Write failing unit tests for pure binding resolution (happy path:
      one bound matched directive + registered enabled skill → winner) in
      backend/tests/unit/modules/chat/directiveBindingResolution.test.ts
- [ ] T007 [P] [US1] Write failing unit tests for `ChatTurnSkillSelector` binding
      routing (bound skill wins over first-`selects()` default; no bindings → exactly
      today's behavior; decision reason `directive:<name>`) beside existing selector
      tests in backend/tests/unit/modules/chat
- [ ] T008 [P] [US1] Write failing unit tests for authoring validation (unknown skill,
      disabled skill, routine-only invocation mode → descriptive error naming the
      skill; valid skill passes) in backend/tests/unit/modules/agents
- [ ] T009 [US1] Implement pure helper
      backend/src/modules/chat/services/directiveBindingResolution.ts per
      data-model.md `DirectiveBindingResolution` (winner only in this story; losers/
      skipped shapes present but exercised in US2); T006 green
- [ ] T010 [US1] Wire binding resolution into
      backend/src/modules/chat/services/turnSkillSelector.ts (`resolveSkill` +
      `select`: consult resolver with `session.directiveSteering?.matches`, agent
      skill state, and registered turn skills; fall back to existing first-match;
      keep `TurnSelectionStrategy` untouched); T007 green
- [ ] T011 [US1] Implement authoring-time binding validation in the agents module
      service used by directive create/update (skill exists on agent + enabled +
      turn-capable invocation mode; import path exempt); T008 green
- [ ] T012 [US1] Add `binding` to directive request/response schemas in
      backend/src/app/http/openapi/schemas/agentSchemas.ts, regenerate OpenAPI
      (`pnpm run generate:openapi` in backend/), and extend the existing directives
      contract tests in backend/tests/contract to cover the field (write failing
      contract assertions first, then regenerate)
- [ ] T013 [US1] Sync the TypeScript SDK generated types: `cd typescript-sdk &&
      pnpm run sync && pnpm run build && pnpm test`; commit regenerated output only

**Checkpoint**: US1 independently functional — bound directive routes a live turn.

## Phase 4: User Story 2 — Predictable conflict & unavailability (P2)

**Goal**: deterministic winner among multiple bindings; graceful, observable
fall-through when the bound skill is unavailable; routine turns untouched.

**Independent test**: quickstart.md step 5 plus multi-directive unit scenarios.

- [ ] T014 [P] [US2] Write failing unit tests for conflict ordering in
      backend/tests/unit/modules/chat/directiveBindingResolution.test.ts: priority
      desc; null priority ranks as 50; confidence desc; deterministic `always` match
      ranks as certain (1.0); missing confidence on probabilistic match; directive
      name asc final tie-breaker; two directives bound to the same skill → no
      conflict, highest-ranked named
- [ ] T015 [P] [US2] Write failing unit tests for fall-through/skip reasons
      (`skill_not_registered`, `skill_not_enabled`, `skill_not_turn_capable`) and for
      "binding ignored but text steering unaffected" at the selector level
- [ ] T016 [US2] Complete resolver ordering + skip classification in
      backend/src/modules/chat/services/directiveBindingResolution.ts; T014/T015 green
- [ ] T017 [US2] Emit warn-level log on skipped bindings (workspaceId, agentId,
      conversation/session id, directive name, skill name, skip reason — never
      message content) from the selector's host wiring; assert via logger spy in unit
      tests
- [ ] T018 [US2] Add regression test proving routine turns never evaluate bindings
      (routine path does not run terminal selection — cover via existing routine
      engine/backend test seams; document the covering test in tasks notes if one
      already exists)

**Checkpoint**: conflict + fall-through deterministic and observable.

## Phase 5: User Story 3 — Diagnosable and portable bindings (P3)

**Goal**: trace records winner/losers/skips; agent config export/import round-trips
bindings.

**Independent test**: quickstart.md step 7 + trace assertions.

- [ ] T019 [P] [US3] Write failing tests: `SelectionDecision`/engine conversation
      trace carries winner reason `directive:<name>` plus losing and skipped binding
      records (directive name, skill name, outcome, reason) at the selector seam
- [ ] T020 [P] [US3] Write failing round-trip tests for `AuthoredDirectiveConfig`
      export/import preserving `binding` (including import into an agent lacking the
      skill — preserved, no validation error) beside existing agentConfig tests
- [ ] T021 [US3] Implement trace enrichment in
      backend/src/modules/chat/services/turnSkillSelector.ts (+ resolver output
      mapping); T019 green
- [ ] T022 [US3] Add `binding` to `AuthoredDirectiveConfig` serialize/materialize in
      backend/src/modules/agents/agentConfig.ts; T020 green

**Checkpoint**: all three stories complete.

## Phase 6: Polish & Cross-Cutting

- [ ] T023 [P] Update docs/architecture/conversational-directives.md: binding concept,
      conflict rule, fall-through, inert-with-routine/step-scope-tags caveat (read
      docs/document-writer-prompt.md first)
- [ ] T024 [P] Update docs-portal/content/api/agents-and-skills.mdx (or the page that
      owns the directives API) with the `binding` field, validation errors, and
      examples (read docs/document-writer-prompt.md first)
- [ ] T025 Record the message-queue impact review outcome (none — in-turn selection
      only) in the PR body; confirm no worker/AMQP/queue tests or docs are affected
- [ ] T026 Full validation: `cd backend && pnpm exec tsc --noEmit && pnpm run
      test:unit && pnpm run test:contract`; then repo `pnpm run ci:local -- origin/main`
      (grep the log for the real exit status; do not trust piped exit codes)

## Dependencies

- Phase 2 blocks everything (contract type + column + schema).
- US1 (Phase 3) is the MVP and blocks US2/US3 only where they extend the same files
  (resolver, selector); US2 and US3 test tasks [P] can be authored in parallel.
- Polish requires all stories complete.

## Implementation Strategy

MVP-first: land Phase 2 + US1, validate with quickstart steps 2-4/6, then US2
(conflict/fall-through), then US3 (trace/round-trip), then docs + full CI. Small,
reviewable Conventional Commits per phase.
