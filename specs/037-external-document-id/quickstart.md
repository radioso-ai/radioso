# Quickstart: External Document ID

## Scenario 1: Backward-compatible create without external identity

1. Create a document through `POST /api/v1/document/` without `externalDocumentId`.
2. Repeat the same request.
3. Confirm two distinct internal document IDs are created, preserving current behavior.

## Scenario 2: Idempotent create with external identity

1. Create a document through `POST /api/v1/document/` with `externalDocumentId = "crm-123"`.
2. Repeat the request with updated content and the same `externalDocumentId`.
3. Confirm the response returns the same internal `documentId` both times.
4. Retrieve the document by internal ID and confirm the later content is stored.

## Scenario 3: Cross-tenant reuse

1. In workspace A, create a document with `externalDocumentId = "crm-123"`.
2. In workspace B, create a different document with `externalDocumentId = "crm-123"`.
3. Confirm both requests succeed and each workspace retains its own document.

## Scenario 4: Immutable identity on update

1. Create or upsert a document with `externalDocumentId = "crm-123"`.
2. Attempt to update the same internal `documentId` with `externalDocumentId = "crm-456"`.
3. Confirm the request is rejected with a conflict error.
4. Retrieve the document and confirm `externalDocumentId` is still `"crm-123"`.

## Scenario 5: First assignment to an existing internal document

1. Create a document without `externalDocumentId`.
2. Update it by internal `documentId` and set `externalDocumentId = "crm-123"`.
3. Confirm the assignment succeeds.
4. Attempt to assign `"crm-123"` to a different document in the same workspace.
5. Confirm the second assignment is rejected with a conflict error.
