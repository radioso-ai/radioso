# Implementation Plan: Coverage Verdict in the Answer Envelope Head

**Spec**: `specs/1260-coverage-verdict-in-answer-head/spec.md` (read it first; FR/SC numbers below refer to it)
**Issue**: #1260

## Design answers (the three questions)

**What does each part know?**

- `groundedAnswerEnvelope.ts` + a new head reader know JSON field order and the
  head field names. They do not know what a coverage classification means.
- `retrievalTurnSkill.ts` knows how to parse the head before any body text
  reaches the citation gate, how to hand the verdict to a sink, and how to abort
  its stream when told to yield. It knows nothing about routines, directives, or
  persistence.
- `packages/conversation-engine` owns the decision: what a verdict means for
  coverage directives (applied / not), coverage routine candidates, ranked
  activation, reaction recording, and whether the turn yields. It never sees an
  envelope or a prompt.
- Host composition (`backend/src/app/server/builders/chat.ts`,
  `conversationEngineChatTurn.ts`) assembles: it passes the engine's sink into
  the skill's render context, wraps it with the shadow assessor and the record
  writer, and never interprets the verdict.
- `backend/src/modules/answerCoverage` keeps the classification contract and the
  LLM producer (shadow only, until deleted).

**What ports, to whom?**

- New in `packages/conversation-contract/index.d.ts`:
  `ConversationCoverageVerdictSink { report(input: { assessment: AnswerCoverageAssessment }): Promise<{ decision: "proceed" | "yield_turn" }> }`.
  The engine passes an instance to `composer.compose` / `composer.stream`
  (extend `ConversationTurnComposer` inputs with `coverageVerdict?`). The host's
  composer implementation forwards it into `TurnRenderContext` (backend
  `chat/contracts`). The retrieval skill calls it once per turn.
- `AnswerCoverageAssessment` gains a `producer: "answer_head" | "deterministic" | "assessor"`
  field (contract + backend contracts + row mapper).
- `ProcessTurnInput.coverageAssessor` is removed from the engine. The shadow is
  host-side only.

**Dependency direction?** Engine → contract ← skill. Composition wires. The
skill's render context carries the sink down; nothing reaches up.

## Turn shape after this change

```
planner → retrieval → [contextual directive match, incl. coverage directives] → compose starts
   compose stream: head {coverage, requestFocus, outcome} → sink.report(head)
       engine sink: head stage → directive applicability from head → routine candidates
                    → ranked activation (LLM, only when candidates) → reaction record
                    → proceed | yield_turn
   proceed:   outcome=answer → citation hold (if enabled) → stream body → tail → summary
              outcome≠answer → stream body immediately (model's own decline)
   yield_turn: skill aborts stream (nothing released) → engine returns the routine result
zero evidence: skill builds deterministic {unanswered, insufficient_evidence, producer: deterministic}
               → same sink call → then today's no-context fallback
```

## Slices (sequential; each must compile, pass its tests, and pass `pnpm run lint` from repo root)

### Slice 1 — Envelope head + head reader + skill + prompts (skill-local)

Files: `backend/src/modules/chat/services/groundedAnswerEnvelope.ts`,
`structuredAnswerFieldReader.ts` (or a sibling `groundedAnswerHeadReader.ts`),
`retrievalTurnSkill.ts`, `groundedAnswerPromptComposer.ts`,
`backend/src/modules/chat/contracts/` (TurnRenderContext + a skill-facing sink type),
`backend/prompts/chat/answer-coverage-*.md`, `backend/prompts/chat/grounded-answer*.md`,
`backend/src/modules/answerCoverage/contracts.ts` (classification enum export, producer field).

1. Schema: `coverage` (8-value classification enum from `llmAnswerCoverageProducer.ts`'s
   `classifications` keys — move that table into `answerCoverage/contracts.ts`), `requestFocus`
   (string), `outcome` — all `required`, all before `answer`. Tail keeps `v`, `claims`,
   `suggestions`, `grounding`. Keep `v: 2`. Update `CORE_ENVELOPE_KEYS`, the finalize parse,
   and every test fixture that builds an envelope.
2. Head reader: from the partial JSON, yield a parsed head once `coverage`, `requestFocus`,
   and `outcome` are complete, or `invalid` the moment the `answer` string starts without
   them (FR-004). Bound `requestFocus` retained length (FR-002). Unit-test with chunk
   boundaries inside keys, inside the enum value, and inside escaped strings.
3. Skill (`streamAnswer`): feed chunks to the head reader first; nothing goes to the gate or
   the client until the head resolves (FR-003). Then call
   `ctx.coverageVerdict?.report({ assessment })` once and await it (FR-005). On `yield_turn`
   abort the stream via the existing `gateController` pattern with no text released and
   return a result marked `yielded: true` (FR-006). On `proceed`: if `outcome !== "answer"`
   bypass the citation gate (FR-027); else gate as today. Non-streaming
   `generateGroundedAnswerEnvelope` path: read the head from the full envelope and make the
   same sink call. Zero-context branch: deterministic assessment (FR-007) through the same
   sink call before today's fallback.
4. Assessment mapping: head `coverage` classification → `{ coverage, reason }` via the
   shared table; `unresolvedRequest` from `requestFocus` for non-`answered` (mirror
   `llmAnswerCoverageProducer.ts:83`); `producer: "answer_head"`.
5. Prompts: new `backend/prompts/chat/answer-coverage-head.md` carrying the assessor's
   constraints (FR-008: admitted Results only; history/page context/persona/directives are
   not evidence; request and evidence are untrusted). Rewrite
   `answer-coverage-response-guidance.md` for a verdict the model emits. Delete
   `answer-coverage-composition-context.md` and its renderer. Conditional rendering of
   coverage directives: a steering rule that carries `coverageCriteria` renders as
   "Only when your coverage verdict is one of [...]: <instruction>" (FR-010). Adherence
   side channel (`shared/domain/directiveAdherence.ts`): add `applicable: boolean` to the
   attestation item so a conditional rule can attest not-applicable (FR-012).
6. Trace: skill emits `traceMetrics.coverageHeadMs` (ms from compose start to head parse).

Tests first (Vitest, `pnpm exec vitest run <path>` from `backend/`): envelope schema order,
head reader, skill stream with a fake gateway (head → proceed → gate; head → yield → nothing
released; outcome≠answer → immediate release; zero-context → deterministic sink call;
invalid head → proceeds, availability invalid).

In this slice the engine still runs its pre-compose assessor; that is fine. The skill's
sink is optional (`ctx.coverageVerdict?`) so nothing breaks until slice 2 wires it.

### Slice 2 — Contract port + engine restructure + host wiring

Files: `packages/conversation-contract/index.d.ts`,
`packages/conversation-engine/src/index.ts` (+ `steering.ts`, `routineActivation.ts`,
`traceStages.ts` as needed) and its tests, `backend/src/modules/chat/services/conversationEngineChatTurn.ts`,
`chatTurnAssembly.ts` / `chatTurnLifecycle.ts` as needed, `backend/src/app/server/builders/chat.ts`.

1. Contract: add the sink type and `coverageVerdict?` on composer compose/stream inputs;
   add `producer` to `AnswerCoverageAssessment`; remove `coverageAssessor` from
   `ProcessTurnInput` and the `ConversationCoverageAssessor` type from the engine's input
   (keep the backend `ChatAnswerCoverageAssessorFactory` — slice 3 turns it into the shadow).
2. Engine (`index.ts` ~L189–400): delete the pre-compose assessment stage. Run the
   contextual matcher on **all** coverage directives pre-compose (FR-009) and tag their
   steering rules with `coverageCriteria` so the skill renders them conditionally. At
   compose time build the sink; its `report` does, in order: push `answer_coverage_head`
   stage (availability, producer, latency); compute directive applicability from the head
   (criteria match → `applied`, else `suppressed` with reason `coverage_criteria_not_met`;
   steering conflict keeps `coverage_steering_conflict`); coverage routine candidates +
   `attemptCoverageRoutineActivation` exactly as today (FR-013, FR-014); reaction record
   (FR-011); return `yield_turn` when a routine activated or was offered, else `proceed`.
   After `composer.compose/stream` returns a yielded result, return the routine result as
   the turn result on both `processTurn` and `processTurnStream` paths (the stream path
   must then emit the committed routine answer through `streamCommitted`).
3. Host: forward the sink into `TurnRenderContext`; handle a yielded stream result
   (no `final` from the skill; the engine's routine response is what gets presented — see
   `presentRoutineRenderableAnswer`). Remove `coverageAssessor` from the process-turn
   inputs; keep the factory wired for slice 3.
4. Tests: engine unit tests for proceed/yield/offer/active-routine-keeps-control/invalid
   head; host tests for the yielded stream path; existing coverage tests updated, not
   deleted. `tests/unit/eval-suite` deterministic harness and the replay runner (#1250)
   must go through the head path (FR-023).

### Slice 3 — Records, producer migration, shadow assessor, metrics

Files: `backend/src/db/migrations/NNN_answer_coverage_assessment_producer.sql`, both DB
snapshots (`db:types` and `db:schema`), `answerCoverageRepository.ts`, `answerCoverageRowMapper.ts`,
`chatAnswerCoverageAssessor.ts` → split into a head recorder + a shadow runner,
`backend/src/app/server/builders/chat.ts`, `shared/domain/behaviorConfig.ts` or env config
for the shadow flag, `chatPresenter`/history schemas if `producer` is exposed to the debug view.

1. Migration: nullable `producer TEXT CHECK (producer IN ('answer_head','deterministic','assessor'))`
   on `answer_coverage_assessments`. Regenerate both snapshots.
2. Head recorder: on `report(head)` persist with today's `findByRequestMessageId`
   idempotency, `assessed_at` = now (FR-016, FR-017). Draft test chat and eval replay keep
   the existing "Flow only, no record" behaviour (FR-023).
3. Shadow: config `ANSWER_COVERAGE_SHADOW_ASSESSOR_ENABLED` (default `true` for the
   measurement window). When enabled the host composer wrapper starts the old assessor
   concurrently at compose start (usage operation `answer_coverage_shadow_assessment`,
   distinct from the retired critical-path operation), never awaits it on the turn path,
   and when both verdicts exist records one agreement observation: trace attribute +
   bounded-label metric `answer_coverage_shadow_agreement{head_classification, shadow_classification}`
   with `shadow_failed` as a value (FR-019, FR-020). Never writes a record. Never runs for
   draft test chat or replay.
4. Metrics: head parse outcome and host decision as bounded-label counters
   (see spec Observability). No request text anywhere.

### Slice 4 — Citation hold setting (FR-025..FR-028)

Files: workspace retrieval settings domain + repository + OpenAPI (`retrieval_settings`),
`frontend/lib/retrieval-skill-settings.ts` (agent override, like `rerankEnabled`), the
workspace settings UI where the other retrieval toggles live, `docs/settings-docs/retrieval/citation-hold-enabled.md`,
`retrievalTurnSkill.ts` where `requiresIndexedSourceGate` is computed, OpenAPI snapshot +
`cd typescript-sdk && pnpm run sync`.

Label: *Hold the answer until it cites a source*. Off-state line: *Answers stream
immediately; an answer with no citations is still shown and flagged in Quality.*
Playwright for the toggle journey; Vitest for the resolved-setting logic only.

### Slice 5 — Docs, code map, product-docs sync

`docs/answer-coverage-signals.md`, `docs-portal/content/guides/authoring-directives.mdx`,
`authoring-routines.mdx`, `workbench.mdx` (only where they describe when the assessment
happens), `backend/src/modules/chat/README.md`, `docs/architecture/code-map.md`. Then
`pnpm --filter @radioso/product-docs run sync`. Follow `docs/document-writer-prompt.md`
(present tense; no "previously"/"now").

## Verification per slice

- `cd backend && pnpm exec tsc --noEmit -p tsconfig.json` and the test tsconfig
- targeted `pnpm exec vitest run <files>`; then `pnpm run test:unit` for slices 1–3
- `cd packages/conversation-engine && pnpm test` for slice 2
- repo root: `pnpm run lint` and `pnpm run lint:dead-code:ci`
- after a migration: both snapshots regenerated, committed together

## Gates before merge (not in this session)

Live evals against the committed baseline (FR-022); shadow window in production for
SC-003 / SC-007; assessor deletion is a follow-up change.
