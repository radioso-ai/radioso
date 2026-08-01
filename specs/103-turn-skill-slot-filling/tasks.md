# Tasks: Skill Slot Filling

**Input**: Design documents from `/specs/103-turn-skill-slot-filling/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/skill-slot-filling.md`, and `quickstart.md`

**Tests**: TDD is mandatory. For every production-code task below, first add the named focused Vitest coverage, run it to demonstrate the red state, then implement only enough to make it pass. Do not run any package build. Type checks use `pnpm exec tsc --noEmit -p <package>/tsconfig.json` only.

**Architecture**: `conversation-contract` owns the declaration, resolver port, and result vocabulary; `conversation-defaults` owns the model-facing resolver, prompt boundary, deadline, and private normalizer; `conversation-engine/src/index.ts` stays orchestration-only and owns two-phase sequencing, parked-turn composition, and redacted traces; `conversation-kit/src/composition.ts` only wires the default/override resolver; `conversation-tools/src/skillBridge.ts` must not project raw transport schema. Keep routine `inputBindings` and `slotCorrection.ts` unchanged.

## Required Minimum Test Coverage Map

| Spec minimum that cannot be cut | Task coverage |
|---|---|
| Ready declared values | T004, T008 |
| Missing required input and one composed ask | T010–T012 |
| Invalid choice and invalid type | T015, T017 |
| Host override with no model call | T004, T008 |
| Multi-selection means zero dispatch until all are ready | T005, T011 |
| Parked stream emits a final result | T011 |

## Phase 1: Setup and Contract-Scope Review

**Purpose**: Confirm the deliberately narrow package-only contract impact before code work.

- [ ] T001 [P] Reconfirm and retain the recorded no-impact message-queue/OpenAPI review (no worker dispatch, AMQP payload, retry, queue test/doc, backend registry, generated OpenAPI, or MCP schema-projection change) in `specs/103-turn-skill-slot-filling/{plan.md,research.md,contracts/skill-slot-filling.md}`.

---

## Phase 2: Foundational Contract Migration (Blocking)

**Purpose**: Establish the typed cross-package seam without ever leaving `conversation-tools` uncompilable.

**⚠️ CRITICAL**: Complete T002 before T003. T003 is one atomic source change: do not merge the `SkillDefinition.inputSchema` type break separately from the conversation-tools producer migration.

- [ ] T002 [P] Write a failing raw-MCP/OpenAPI-schema bridge regression test that proves transport `ConversationToolDefinition.inputSchema` and existing metadata/dispatch bridging remain intact while emitted `ToolSkillDefinition` omits `inputSchema` in `packages/conversation-tools/tests/toolBridge.test.ts`.
- [ ] T003 Atomically replace `SkillDefinition.inputSchema?: unknown` with the scalar field declaration, resolver/result/awaiting-input contract vocabulary, and migrate `toolToSkillDefinition` to omit raw transport schema in `packages/conversation-contract/index.d.ts` and `packages/conversation-tools/src/skillBridge.ts`; immediately verify `pnpm exec tsc --noEmit -p packages/conversation-tools/tsconfig.json` passes.

**Checkpoint**: The public contract is concrete, the only existing raw-schema producer is migrated in the same change, and conversation-tools type checks.

---

## Phase 3: User Story 1 - A declared field is filled from the conversation (Priority: P1) 🎯 MVP

**Goal**: A directive-bound kit skill receives declared canonical fields from the current message or bounded history, while no-fields skills retain current behaviour.

**Independent Test**: Register a skill with required `calendar_date` and optional choice-constrained `haircut_style`, bind it to a directive, and prove the local handler receives the canonical declared input from a message or earlier history without an extra call for a no-fields or complete host-input selection.

### Tests for User Story 1 — write and demonstrate failure first

- [ ] T004 [P] [US1] Add failing ready-resolution tests for current-message and two-turn history extraction, optional-field absence, complete valid host input with no extraction call, no-fields skip, bounded newest-20/8,000-character oldest-first history, and UTC/default plus injected-IANA-zone date prompting in `packages/conversation-defaults/tests/skillInputResolver.test.ts`.
- [ ] T005 [P] [US1] Add failing engine tests that require one resolver call per declared selection against the same immutable pre-dispatch snapshot, preserve original `SelectedSkill.input` for no-fields skills, and retain A-to-B staged-context/transient-guidance dispatch behaviour once every resolution is ready in `packages/conversation-engine/tests/defaultConversationEngine.test.ts`.

### Implementation for User Story 1

- [ ] T006 [P] [US1] Create the default resolver with bounded untrusted history/current-message prompt construction, authoritative validated host input, ready resolution, clock/time-zone configuration, and a public factory export in `packages/conversation-defaults/src/skillInputResolver.ts` and `packages/conversation-defaults/src/index.ts`.
- [ ] T007 [P] [US1] Add the resolver input seam and two-phase ready preflight/dispatch orchestration without provider, parsing, or normalizer logic in `packages/conversation-engine/src/index.ts`.
- [ ] T008 [US1] Add a failing kit integration test covering directive-bound declared values from one message and history, optional absence, complete host-selected input without model extraction, and unchanged no-fields dispatch in `packages/conversation-kit/tests/composition.test.ts`.
- [ ] T009 [US1] Wire the default resolver from the existing kit model gateway, with an optional host/test resolver override and no routine-dispatch changes, in `packages/conversation-kit/src/composition.ts`.

**Checkpoint**: A ready declared skill dispatches only canonical input; a no-fields skill incurs neither resolver nor model latency.

---

## Phase 4: User Story 2 - A missing required field asks instead of dispatching (Priority: P1)

**Goal**: Unsatisfied required fields park every selected skill before side effects, return `awaitingSkillInput`, and use ordinary composition to ask once.

**Independent Test**: Omit a required field for a directive-bound skill and prove that no handler runs, one composed reply asks for all missing fields/choices, and an `always` directive can re-match and fill the next answer turn.

### Tests for User Story 2 — write and demonstrate failure first

- [ ] T010 [P] [US2] Add failing resolver tests for required-missing field reports (`absent` versus rejected host value), multiple outstanding fields, and a later valid answer under an `always` directive in `packages/conversation-defaults/tests/skillInputResolver.test.ts`.
- [ ] T011 [P] [US2] Add failing engine tests for all-selected preflight (needs-input or failed means zero dispatches), `awaitingSkillInput` propagation through normal and stream results, one synthetic skill steering request with choices, ordinary composed reply, and a parked stream `final` event instead of `conversation_stream_missing_final` in `packages/conversation-engine/tests/defaultConversationEngine.test.ts`.
- [ ] T012 [P] [US2] Add a failing kit end-to-end test for a missing required value: no handler invocation, one request for all missing fields and choices, exposed `awaitingSkillInput`, repeated rejection parking, and successful `always`-directive re-match after the answer turn in `packages/conversation-kit/tests/composition.test.ts`.

### Implementation for User Story 2

- [ ] T013 [US2] Extend the resolver's tagged decisions to return required-field needs-input reports with safe absent/rejected reasons, without retrying internally or replacing invalid authoritative host values, in `packages/conversation-defaults/src/skillInputResolver.ts`.
- [ ] T014 [US2] Extend the engine's preflight outcome handling, prepared/result constructors, synthetic steering, normal composition, and shared stream path so any parked/failed selection dispatches nothing while only needs-input entries populate `awaitingSkillInput` in `packages/conversation-engine/src/index.ts`.

**Checkpoint**: Missing input produces one ordinary composed prompt and a machine-readable current-turn report; it neither dispatches nor creates durable engine-owned resumption.

---

## Phase 5: User Story 3 - Extracted values are validated before they reach a handler (Priority: P1)

**Goal**: Only declared, canonical scalar values can reach a handler, and rejection observability remains structural and value-free.

**Independent Test**: Return an invalid choice/type and an undeclared key from the model, then prove no invalid/extra value reaches a handler while the trace contains only the field and safe rejection reason.

### Tests for User Story 3 — write and demonstrate failure first

- [ ] T015 [P] [US3] Add failing resolver tests for canonical string/number/integer/boolean/date normalization, permitted-value canonical spelling, invalid choices and uncoercible types as `rejected`, declared-key allowlisting, invalid host values never replaced from extraction, and malformed JSON/model-error/deadline fail-closed outcomes with no value-bearing diagnostics in `packages/conversation-defaults/tests/skillInputResolver.test.ts`.
- [ ] T016 [P] [US3] Add failing engine trace tests asserting one pre-dispatch `skill_input_resolution` stage per selection records only names, ready/absent/rejected outcomes, provenance, and safe rejection/failure codes—never fake values, raw JSON, prompt, history, current message, or host input—in `packages/conversation-engine/tests/defaultConversationEngine.test.ts`.
- [ ] T017 [P] [US3] Add a failing kit integration test proving invalid extracted choice/type values park rather than invoke the directive-bound handler, and undeclared model keys never appear in handler input, in `packages/conversation-kit/tests/composition.test.ts`.

### Implementation for User Story 3

- [ ] T018 [US3] Complete the resolver's private deterministic scalar normalizer and safe failure boundary: enforce the exact v1 types, string-only permitted values, undeclared-key discard, prompt/data separation, one extraction call, `Promise.race` deadline, and fail-closed parsing/provider errors in `packages/conversation-defaults/src/skillInputResolver.ts`.
- [ ] T019 [US3] Add only structural redacted `skill_input_resolution` trace staging immediately before possible skill dispatch, preserving routine `inputBindings` and leaving `packages/conversation-engine/src/slotCorrection.ts` untouched, in `packages/conversation-engine/src/index.ts`.

**Checkpoint**: Invalid or undeclared values cannot reach handlers, failures stop all dispatch, and traces are useful without leaking conversation or argument content.

---

## Phase 6: Documentation and Cross-Cutting Validation

**Purpose**: Finish the documented kit surface and verify the complete TDD slice without builds.

- [ ] T020 Read `docs/document-writer-prompt.md`, then document typed field declarations, canonical handler input, `awaitingSkillInput`, zero dispatch while parked, and the host-forced retry limitation for contextual directives in `packages/conversation-kit/README.md`.
- [ ] T021 Run the focused Vitest coverage mapped in `specs/103-turn-skill-slot-filling/quickstart.md` for `toolBridge`, `skillInputResolver`, `defaultConversationEngine`, and kit composition, plus the listed no-build `tsc --noEmit -p` checks for all five conversation packages; do not run a build command.
- [ ] T022 [P] Manually verify the README example and all quickstart scenarios against `specs/103-turn-skill-slot-filling/{spec.md,plan.md,contracts/skill-slot-filling.md,quickstart.md}`: ready, missing, invalid choice/type, host override/no model call, multi-selection zero dispatch, streaming final rendering, routine compatibility, and no backend/dashboard/MCP projection scope creep.

---

## Dependencies & Execution Order

```text
T001 ──────────────────────────────────────────────────────────────────┐
T002 → T003 (atomic contract + tools migration; conversation-tools tsc) │
                  │                                                     │
                  ├→ T004, T005 → T006, T007 → T008 → T009             │
                  ├→ T010, T011, T012 → T013, T014                     │
                  └→ T015, T016, T017 → T018, T019                     │
                                      └──────────────→ T020 → T021 ────┤
T022 (manual scope/docs review) ───────────────────────────────────────┘
```

- **Foundational dependency**: T003 blocks every story because it changes the shared TypeScript contract. It must include its tools migration in the same change and prove conversation-tools type checks before any later task starts.
- **Story dependencies**: US1 establishes the ready resolver/orchestration/kit wiring. US2 extends those seams for parking; US3 extends them for normalization and redacted trace safety. Each has independently executable acceptance coverage, but implementation should follow this order to avoid same-file conflicts.
- **TDD dependency**: T004/T005 precede T006/T007; T008 precedes T009; T010/T011/T012 precede T013/T014; T015/T016/T017 precede T018/T019. Run each named test suite red before its associated source change and green afterward.
- **Critical path**: T002 → T003 → T004 → T006 → T005 → T007 → T008 → T009 → T010 → T013 → T011 → T014 → T015 → T018 → T016 → T019 → T020 → T021.

## Parallel Opportunities

- After T003, T004 and T005 may be authored in parallel; once red, T006 and T007 modify different packages and may be implemented in parallel.
- Within US2, T010–T012 are separate test files and may be authored in parallel. Within US3, T015–T017 are likewise parallel; T018 and T019 then modify distinct packages.
- T001 and T022 are review-only tasks and can run alongside source work, but T022 is only signed off after the relevant tests and docs exist.

### Parallel Example: User Story 2

```text
Task T010: resolver missing-input tests in packages/conversation-defaults/tests/skillInputResolver.test.ts
Task T011: parked engine/stream tests in packages/conversation-engine/tests/defaultConversationEngine.test.ts
Task T012: missing-input kit tests in packages/conversation-kit/tests/composition.test.ts
```

## Implementation Strategy

### MVP First (User Story 1)

1. Complete T001–T003 so the type break and tools producer migration land atomically.
2. Complete T004–T009 with red-green focused tests.
3. Validate the ready path independently before adding parking or extra validation branches.

### Incremental Delivery

1. Foundation: concrete contract plus a compilable tools bridge.
2. US1: ready extraction and compatibility paths.
3. US2: safe parking and stream-final parity.
4. US3: deterministic validation and redacted observability.
5. Documentation and no-build validation.

## Format Validation

All 22 implementation tasks use the required checkbox, sequential `T###` identifier, optional `[P]` marker only where different-file work can proceed independently, required user-story label in story phases, and exact file paths.
