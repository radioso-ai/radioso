# Research: Precise Citation Placement

**Date**: 2026-03-16  
**Branch**: `010-precise-citations`

## Decision: Citation Anchor Format

Use `[[N]]` anchors in the raw model output, where `N` is the 1-based index of the retrieved context entry shown to the model (e.g., "Result 1", "Result 2").

Rationale:

- Matches an established pattern (Skald-style) and is easy to parse deterministically.
- Can be filtered out of streaming chunks to avoid user-visible placeholder syntax.
- Supports multiple sources per claim via `[[1]][[2]]` sequences.

## Decision: Deterministic Parsing (No Heuristic Placement)

Parse the final raw answer and convert anchors into `answerSegments` by splitting the answer at each anchor boundary, attaching the anchor's validated source(s) to the preceding segment.

Rationale:

- Produces exact placement declared by the backend.
- Avoids overlap-scoring/punctuation heuristics which are inherently unreliable for URLs, prices, and lists.

## Decision: Streaming Sanitization

Remove anchors from streamed chunks before sending them to clients. Maintain the full raw answer (including anchors) server-side for final parsing at completion.

Rationale:

- Frontend currently accumulates streamed text and does not replace it at completion, so streamed text must match the final visible answer.
- Prevents partial anchor artifacts when chunk boundaries split `[[` / `]]`.

## Alternatives Considered

- Heuristic placement based on overlap: rejected due to known misplacement and non-determinism.
- Frontend parsing of anchors: rejected due to modularity and trust boundaries.
- Sending `answer` in SSE completion and overriding the streamed content: rejected to avoid contract/UI churn; current streaming path does not support it.

