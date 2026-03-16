# Quickstart: Precise Citation Placement

## Goal

Verify that chat answers render citations exactly at backend-declared claim boundaries and that streaming does not expose citation-anchor placeholders.

## Preconditions

- Backend running with a seeded account and at least two documents uploaded.
- Retrieval settings enable citation display.

## Manual Test

1. Ask a question that should produce at least two distinct claims sourced from different documents.
2. Confirm the assistant answer renders inline citations at the end of the relevant claim segments.
3. Confirm no raw `[[N]]` placeholder syntax is visible anywhere in the rendered answer.
4. Click each citation marker and confirm it opens the intended document.
5. Repeat with streaming enabled.

## Expected Results

- Citations appear only where the answer is cited; uncited text has no markers.
- Invalid or unknown anchors do not produce markers.
- Streaming displays readable text throughout and the completion adds citation metadata without changing the already-displayed text.

