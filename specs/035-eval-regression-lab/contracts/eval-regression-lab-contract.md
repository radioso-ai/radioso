# Contract Notes: Eval Regression Lab

## Purpose

Document the approved additive contract changes for workspace-scoped eval datasets, conversation import, replay execution, and run comparison before implementation.

## Eval Dataset API

- New authenticated eval endpoints are additive and workspace-scoped.
- Expected endpoint families:
  - `GET /api/v1/evals/datasets`
  - `POST /api/v1/evals/datasets`
  - `GET /api/v1/evals/datasets/{datasetId}`
  - `PATCH /api/v1/evals/datasets/{datasetId}`
  - `POST /api/v1/evals/datasets/{datasetId}/cases`
  - `POST /api/v1/evals/datasets/{datasetId}/runs`
  - `GET /api/v1/evals/datasets/{datasetId}/runs/{runId}`
  - `GET /api/v1/evals/datasets/{datasetId}/runs/{runId}/comparison`

## Conversation Import API

- The history experience needs an additive import flow that turns a historical turn into an eval-case draft.
- Expected authenticated import endpoints:
  - `POST /api/v1/evals/import/chat-history`
  - `POST /api/v1/evals/import/public-chat-history`
- Minimum request shape:
  - `conversationId`
  - `assistantMessageId` or equivalent selected turn identifier
  - optional context-selection override
  - optional redaction instructions
- Minimum response shape:
  - `importDraft`
  - seeded expectations derived from stored retrieval trace or validation diagnostics when available
  - explicit unavailable markers when historical diagnostics are missing

## Eval Case Contract Notes

- Case creation must support:
  - manual authoring
  - authenticated conversation import
  - anonymous/public conversation import when authorized
- Each saved case must carry:
  - `query`
  - bounded conversation context
  - provenance metadata
  - expectation configuration
- Expectation dimensions are additive and optional individually:
  - expected documents
  - expected citations
  - expected refusal behavior
  - expected answer-support outcome
  - optional answer checks
  - optional bounded latency checks

## Eval Run Contract Notes

- Running a dataset must produce a persisted run artifact with:
  - run metadata
  - per-case result list
  - aggregate summary
- Each case result should expose:
  - pass/fail or skipped status
  - configured dimension results
  - bounded replay diagnostics
  - baseline comparison outcome when a baseline is supplied or available

## Comparison Contract Notes

- Comparison is defined only for runs of the same dataset.
- The comparison payload should expose:
  - aggregate regression/improvement counts
  - per-case comparison outcomes
  - bounded reasons such as citation loss, document mismatch, refusal mismatch, answer-support policy change, or earlier retrieval-stage degradation
- The comparison payload must distinguish retrieval regressions from answer-only wording drift when retrieval dimensions still pass.

## Behavioral Contract Notes

- The MVP treats deterministic scoring dimensions as the source of truth for pass/fail decisions.
- Exact-answer matching is optional and case-specific, not a required global contract.
- Any future LLM-judge score would be additive and must not replace deterministic results.
- The code-first source of truth for backend schema changes is `backend/src/app/http/openapi/document.ts`.
- `backend/openapi.yaml` and `backend/openapi.json` are generated artifacts that must be regenerated after implementation; they are not planning sources of truth.
