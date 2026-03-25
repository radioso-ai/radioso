# Contract Notes: Answer Support Debug

## Scope

This feature does not introduce a new chat response envelope. The live JSON and SSE completion payloads continue to return:

- `conversationId`
- `answer`
- `citations`
- `answerSegments`
- `retrievalInfo`
- `retrievalTrace`

The behavioral contract changes are:

- `answer` and `answerSegments` may now contain the explicit unsupported notice in place of unsupported substantive content
- only supported segments retain citation indices
- SSE must emit only validated answer text

## Additive History Debug Fields

`GET /api/v1/chat/history/{conversationId}` extends each assistant message's `debug` object with:

- `answerOutcome`: `"grounded_success" | "grounded_degraded_unsupported_segments" | "no_context_refusal"`
- `validation`: {
  - `ran`: boolean
  - `answerModified`: boolean
  - `unsupportedSegmentCount`: number
  - `supportedSegmentCount`: number
  - `nonSubstantiveSegmentCount`: number
}

## OpenAPI Ownership

- Source of truth: `backend/src/app/http/openapi/document.ts`
- Generated artifacts: `backend/openapi.yaml`, `backend/openapi.json`
- Contract tests must continue to compare the generated YAML with `createOpenApiDocument()`

## Non-Goals

- No new operator-facing route
- No raw model output in history debug
- No new database table or message-column contract
