# Quickstart: Document Search

## Goal

Verify that live document search, replayable history, and shared diagnostics work end to end without regressing ordinary document browsing.

## Prerequisites

1. Start the backend and frontend in the usual local development environment.
2. Use a workspace with multiple indexed documents containing overlapping and distinct content.
3. Ensure at least one document can be safely deleted or reprocessed to validate replay degradation behavior.

## Backend Verification

1. Execute a live document search with a non-empty query and confirm:
   - a stable `searchId` is returned
   - ranked documents are returned
   - browse and search responses are distinct
2. Execute a live document search with filters and confirm:
   - only eligible documents appear
   - search still returns a stable `searchId`
3. Execute a query that returns no matches and confirm:
   - response is an explicit no-results outcome, not an error
   - a bounded history entry behavior matches the approved contract
4. List prior document searches and confirm the new search run appears with summary fields.
5. Replay one prior search by `searchId` and confirm:
   - the stored result page is returned
   - replay is marked as historical snapshot mode
   - retrieval trace is returned or explicitly unavailable
6. Delete or reprocess one previously matched document, replay the historical search again, and confirm:
   - replay still shows the stored results
   - downstream actions on missing documents degrade with an explicit unavailable state

## Frontend Verification

1. Open the Documents page and confirm the ordinary browse list still loads with no active query.
2. Run a search from the top bar and confirm:
   - ranked results render in the Documents surface
   - loading, failure, and no-results states are explicit
   - visible actions include open document, inspect evidence, diagnostics/history, and rerun search
3. Clear the query and confirm the page returns to ordinary browsing.
4. Open a stored historical search from the dashboard flow and confirm:
   - the UI distinguishes historical replay from fresh execution
   - the same shared trace graph mental model is used

## Regression Checks

1. Existing document CRUD, import, delete, and reprocess flows still work.
2. Chat history and chat retrieval trace flows still work unchanged.
3. Generated OpenAPI artifacts are refreshed from `backend/src/app/http/openapi/document.ts`.
