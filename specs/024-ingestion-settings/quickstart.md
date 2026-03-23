# Quickstart: Ingestion Settings Controls

## Goal

Verify that ingestion controls live in their own settings surface, affect future document preparation, and allow safe workspace-level reprocessing for eligible existing documents.

## Prerequisites

- Backend test database available
- Frontend and backend dependencies installed
- Authenticated workspace available through the standard settings UI

## Verification Flow

1. Load the Settings screen and confirm the tab order is:
   - `General`
   - `Ingestion`
   - `Retrieval`
   - `Chat Connectors`
2. Open `Ingestion` and confirm it shows:
   - chunking strategy selector
   - fixed-window chunk size
   - fixed-window chunk overlap
   - structured minimum chunk size
   - structured maximum chunk size
   - explanation that changes apply to future ingests and updates
   - workspace reprocess action
3. Open `Retrieval` and confirm chunking controls no longer appear there.
4. Save valid ingestion settings and reload the page.
   - Confirm the saved values round-trip through the ingestion settings API.
5. Try invalid ingestion settings combinations.
   - overlap equal to chunk size
   - structured minimum larger than structured maximum
   - unsupported chunking strategy
   - Confirm the API rejects them and the UI preserves the last valid state.
6. Ingest or update a document after changing ingestion settings.
   - Confirm the resulting chunk set reflects the saved settings for the active strategy.
7. Start workspace reprocess from the Ingestion tab in a workspace with existing documents.
   - Confirm eligible documents are queued.
   - Confirm already `queued` or `processing` documents are skipped rather than duplicated.
8. Re-run the workspace reprocess action while queued work is still present.
   - Confirm the response remains safe and does not create duplicate queued work for already in-flight documents.

## Suggested Test Commands

```bash
cd /Users/dm/conductor/workspaces/radioso/edinburgh/backend
npm test -- contract/settings.contract.test.ts integration/document-settings.integration.test.ts unit/retrieval-settings-and-chunking.test.ts
```

## Expected Artifacts To Update During Implementation

- ingestion settings backend domain, service, repository, and migration
- settings routes and code-first OpenAPI registry
- document processing wiring to read ingestion settings
- workspace bulk reprocess orchestration
- settings UI tab layout and ingestion panel
- API client types and methods
