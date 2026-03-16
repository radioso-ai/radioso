# Quickstart: Conversational Subject Continuity

## Goal

Validate that retrieval preserves coherent subject continuity across context-dependent turns without mutating the stored/displayed user message and without over-indexing on stale subject state.

## Prerequisites

- Work in `/Users/dm/code/hivec-subject-carry-forward`
- Approved spec and plan are present under `specs/012-subject-carry-forward/`
- Backend test environment is available for Vitest and Supertest

## Implementation Order

1. Write failing unit tests for normalized subject identity, convergence metrics, and raw-vs-biased disagreement outcomes.
2. Write failing unit tests for `QueryRewriteService` or its replacement seam using structured carried-subject input rather than regex-driven extraction from prior user text.
3. Write failing retrieval-pipeline unit tests for `reused`, `newly_established`, `replaced`, `cleared`, and `unresolved` outcomes.
4. Write failing integration tests covering:
   - first-turn named subject establishment
   - shorthand or object-reference follow-up reuse
   - explicit topic change
   - ambiguous follow-up
   - comparison flow
   - zero-pronoun or low-content follow-up
5. Implement focused retrieval-domain seams for subject reference normalization, convergence, and reuse decisions.
6. Wire diagnostics into existing retrieval-info output.
7. Re-run unit, integration, and contract tests.

## Suggested Validation Commands

```bash
cd /Users/dm/code/hivec-subject-carry-forward/backend
npm test -- --runInBand
```

```bash
cd /Users/dm/code/hivec-subject-carry-forward/backend
npx vitest run tests/unit/chat-retrieval.domain.test.ts tests/unit/entity-integrity.test.ts tests/integration/chat.integration.test.ts
```

## Expected Outcomes

- Raw user messages are unchanged in prompts and persisted history.
- Subject carry-forward comes from grounded retrieval state rather than regex substitution over chat text.
- Raw and subject-biased retrieval disagreement is visible in diagnostics.
- Ambiguous or comparative turns do not silently reuse one stale subject.
