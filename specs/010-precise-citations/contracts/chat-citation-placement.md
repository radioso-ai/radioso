# Contract: Chat Citation Placement

## Completed JSON response

The completed chat response continues to return:

- `answer`: visible assistant answer text with raw citation-anchor syntax removed
- `citations`: ordered list of visible cited sources derived only from valid anchors
- `answerSegments`: ordered visible answer segments with exact `citationIndices`
- `conversationId` and `retrievalInfo`: unchanged from the existing chat contract

## Completed SSE `done` event

The SSE `done` event continues to return the same normalized fields as the JSON response:

- `conversationId`
- `citations`
- `answerSegments`
- `retrievalInfo`

## Non-goals

- Do not expose raw model citation-anchor syntax directly to the frontend as the final rendering contract.
- Do not infer placement from answer text similarity once explicit anchors are present.
- Do not change citation click behavior or account-scoped document navigation.
