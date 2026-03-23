# Contract Notes: Retrieval Trace

## Purpose

This feature adds a richer retrieval-diagnostics contract to chat responses and chat-history debug payloads without removing the existing compact retrieval summary.

## Contract Ownership

- Backend HTTP schema changes are owned by `backend/src/app/http/openapi/document.ts`.
- Generated `backend/openapi.yaml` and `backend/openapi.json` remain outputs and must not be hand-edited.
- History replay payloads must stay aligned with the same runtime Zod-backed schemas used by routes and presenters.

## Additive Runtime Contract Changes

### Chat Response

The existing chat response continues to include:

- `conversationId`
- `answer`
- `citations`
- `answerSegments`
- `retrievalInfo`

The feature adds:

- `retrievalTrace?`: Optional `RetrievalTrace` for the completed assistant answer

### Streaming Completion Event

The existing `done` event continues to include:

- `conversationId`
- `answer`
- `citations`
- `answerSegments`
- `retrievalInfo`

The feature adds:

- `retrievalTrace?`: Optional `RetrievalTrace` for the completed assistant answer

### Chat History Message Debug

The existing assistant debug payload continues to include:

- `eventStatus`
- `recordedAt`
- `stream`
- `citationCount`
- `retrievalInfo`
- `errorMessage`

The feature adds:

- `retrievalTrace?`: Optional stored `RetrievalTrace`

## Trace Contract Shape

`RetrievalTrace` design intent:

- stable `traceId`
- trace timestamps and total duration
- ordered `stages`
- explicit `links` for branch and convergence relationships
- optional compatibility `summary`

`RetrievalTraceStage` design intent:

- stable `stageId`
- `kind`
- `label`
- `status`
- bounded `settings`
- bounded `inputs`
- bounded `outputs`
- bounded `metrics`
- optional `reason`
- optional timing fields

## Backward-Compatibility Rules

- Existing `retrievalInfo` remains available for current consumers.
- Clients that do not understand `retrievalTrace` can ignore it safely.
- History payloads may omit `retrievalTrace` for older messages without violating the contract.
- A missing historical trace must be distinguishable from an empty successful trace.

## Bounded Data Rules

- Do not include secrets, unrestricted raw logs, full raw prompts, or full raw document bodies.
- Use bounded summaries, counts, selected identifiers, titles, statuses, and short reason text.
- When a field would exceed safe or useful limits, prefer summarization over omission of the entire stage.
