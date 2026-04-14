# Research: External Document ID

## Decision 1: Enforce tenant-scoped identity with a dedicated document column and unique index

**Decision**: Store `externalDocumentId` as a first-class nullable column on `documents` and enforce uniqueness with a workspace-scoped unique constraint for non-null values.

**Rationale**: The feature needs database-enforced idempotency, not just a display field. A dedicated column and unique index let PostgreSQL prevent duplicate identities within one workspace while allowing the same value in different workspaces. This keeps the internal UUID primary key untouched, which avoids broad downstream schema changes for chunks, jobs, and routes.

**Alternatives considered**:

- Store `externalDocumentId` in JSON metadata only: rejected because metadata cannot safely act as the sole enforcement point for tenant-local uniqueness and conflict-target writes.
- Let clients provide the primary key `id`: rejected because the current schema assumes globally unique UUID document IDs and changing that would ripple across all document relations.
- Create a separate identity-mapping table: rejected because one optional external identity per document is simpler and clearer as an additive document column.

## Decision 2: Make repeated creates with `externalDocumentId` idempotent on the existing write contract

**Decision**: Keep the existing inline document create route as the write entry point and interpret `POST /api/v1/document/` with `externalDocumentId` as a create-or-update operation scoped to that workspace.

**Rationale**: The user explicitly does not want separate endpoints for external identity handling. Reusing the current write contract keeps integrations simple while still allowing the repository to resolve conflicts by workspace and external identity. It also preserves the current non-idempotent behavior for callers that omit `externalDocumentId`.

**Alternatives considered**:

- Add a dedicated upsert endpoint: rejected because it creates a second write contract for the same logical document workflow.
- Require callers to look up internal UUIDs before updates: rejected because it defeats the point of external identity for sync integrations.

## Decision 3: Keep `externalDocumentId` immutable after first assignment

**Decision**: Allow first assignment of `externalDocumentId` to a document that does not already have one, but reject any later attempt to change the stored value.

**Rationale**: Immutability makes retry behavior predictable, prevents accidental rebinding of one Radioso document to a different upstream record, and reduces cross-field ambiguity once downstream chunks and audit records are associated with a document.

**Alternatives considered**:

- Allow unrestricted changes: rejected because it makes reconciliation and auditability harder and increases the risk of silent identity drift.
- Forbid assignment after creation entirely: rejected because some existing documents may need to be linked to an upstream record after they are first created.

## Decision 4: Preserve source-kind protections and internal-ID ownership

**Decision**: External identity support must not change existing source-kind restrictions or make external identity a new canonical relational key.

**Rationale**: The current document model distinguishes inline text from uploaded files and protects imported documents from inline update flows. Keeping the internal UUID canonical avoids accidental changes to retrieval, processing, and deletion logic, while ensuring external identity stays a write-time convenience rather than a schema-wide key migration.

**Alternatives considered**:

- Use external identity as the new system-wide identifier: rejected because it materially expands scope and would require broad refactors.
- Allow external identity to bypass imported-file restrictions: rejected because it would create a hidden write path around existing data-source protections.
