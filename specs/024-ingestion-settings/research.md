# Research: Ingestion Settings Controls

## Decision: Create a dedicated ingestion settings API and persistence model now

**Rationale**: The feature goal is not only a UI rearrangement. It is a conceptual split between document-preparation controls and retrieval/answer controls. Keeping chunking strategy and new size settings inside the retrieval settings payload would preserve the same coupling that the feature is explicitly trying to remove. A dedicated ingestion settings domain and `/api/v1/settings/ingestion` surface keeps ownership clear and makes future ingestion-only settings easier to add.

**Alternatives considered**:
- Keep one shared retrieval settings payload and only move controls in the UI: rejected because backend ownership would stay muddled and the new ingestion controls would continue inflating a retrieval-focused contract.
- Add ingestion fields to retrieval settings temporarily and split later: rejected because this feature is already the migration point and delaying the split would create extra churn in tests, OpenAPI, and clients.

## Decision: Move chunking strategy out of retrieval settings and backfill it into the new ingestion settings store

**Rationale**: `chunkingStrategy` is the existing bridge between retrieval settings and document processing, but it is semantically an ingestion control. The clean migration is to introduce a new ingestion settings table, backfill the current `retrieval_settings.chunking_strategy` value, and give new ingestion fields safe defaults derived from current constants.

**Alternatives considered**:
- Leave `chunkingStrategy` duplicated in both retrieval and ingestion settings: rejected because duplication would make drift and compatibility handling harder.
- Leave the source of truth in retrieval settings and mirror into ingestion settings on reads: rejected because read-time mirroring hides ownership and complicates updates.

## Decision: Expose only chunk-boundary controls with direct operator meaning

**Rationale**: The current code has several internal chunking heuristics, but only a subset is simple enough to explain and validate safely for operators. The first exposed set should be `chunkingStrategy`, fixed-window chunk size, fixed-window overlap, structured minimum chunk size, and structured maximum chunk size.

**Alternatives considered**:
- Expose semantic merge similarity threshold and oversized-fragment thresholds immediately: rejected because these are more brittle, harder to explain, and more likely to produce confusing outcomes for non-expert operators.
- Expose document parsing instructions or model prompts: rejected because the current ingestion pipeline is deterministic and not prompt-driven.

## Decision: Add workspace-level reprocess as a settings-owned action, not a document-list batch client loop

**Rationale**: The Ingestion tab needs one operator action that can re-queue existing documents using the current ingestion settings. Putting this behind a workspace-level settings endpoint avoids multiple browser-side round trips, keeps the action auditable, and preserves the Settings surface as the owner of ingestion configuration changes.

**Alternatives considered**:
- Have the frontend iterate over documents and call the existing per-document reprocess endpoint: rejected because it is slower, noisier, harder to audit, and pushes orchestration into the client.
- Add a batch reprocess route under document routes: rejected because this feature is explicitly initiated from Ingestion settings and should not expand document routes into settings-owned orchestration.

## Decision: Make workspace reprocess idempotent over eligible documents and skip documents already queued or processing

**Rationale**: The simplest safe duplicate-prevention rule is to bulk re-queue only documents that are not already in `queued` or `processing` states. A second request while the first batch is still in flight becomes a no-op for those documents instead of creating duplicate jobs or incrementing revisions again. This keeps the feature additive without introducing a long-lived reprocess-run state machine.

**Alternatives considered**:
- Re-queue every document regardless of current status: rejected because repeated requests could create duplicate jobs and confusing revision churn.
- Add a persistent workspace reprocess run tracker that remains active until all documents finish processing: rejected for the initial feature because it adds more lifecycle complexity than the approved scope requires.

## Decision: Keep OpenAPI ownership in the code-first registry and update contract tests with the split

**Rationale**: The constitution requires runtime-owned HTTP schemas. Since this feature adds new settings endpoints and removes chunking fields from retrieval settings, the canonical changes must land in `backend/src/app/http/openapi/document.ts` and the generated artifacts must be refreshed afterward.

**Alternatives considered**:
- Hand-edit generated OpenAPI files to reflect the new settings shape: rejected by the constitution and likely to drift from runtime behavior.
