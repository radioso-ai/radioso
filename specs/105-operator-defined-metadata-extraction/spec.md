# Feature Specification: Operator-Defined Metadata Extraction

**Feature Branch**: `105-operator-defined-metadata-extraction`
**Created**: 2026-08-18
**Status**: Draft — revision 3, addresses review rounds of 2026-08-18 and 2026-08-19
**Input**: User description: "Metadata extraction is a pretty fixed setup at the moment. If we expand from dates into products — or anything else — it will need the users' help to define how to classify pages and which metadata needs to be extracted."

## Context

Document enrichment today is a closed code contract: five hard-coded document shapes (`event`, `article`, `profile`, `reference`, `generic`), exactly two fact kinds (`event_date`, `article_date`), and per-shape strategies that only ever write `dateFrom`/`dateTo` (`backend/src/modules/documents/domain/enrichment/documentEnrichmentContract.ts`, `enrichmentStrategies.ts`). Supporting a new domain (products, courses, listings) requires new fact kinds and strategies in TypeScript.

The consumption side is already generic. `documents.metadata` / `chunks.metadata` hold flat scalar tags; per-agent metadata rules (`metadataRules` on the retrieve skill) filter and boost on those tags with value types `string|number|date|boolean`; badges render any tag. Only the production side is closed.

This feature makes the extraction schema operator-authored data: operators define document types (classification guidance in natural language — multilingual by construction) and the fields to extract per type. The existing single enrichment LLM call becomes schema-driven. The shipped temporal behavior becomes the built-in entries of the same catalog rather than a parallel system.

### Pinned decisions

1. **Catalog ownership**: document type definitions live at workspace level (one catalog per workspace). Sources keep their existing tri-state enablement (`inherit`/`on`/`off`). Per-source type pinning is out of scope for this spec entirely (see Out of Scope) and will be specified separately.
2. **Classification contract**: one LLM call per document — call count unchanged. The prompt is built from the enabled catalog types plus the reserved fallback `generic`; the output is validated in two stages (classification envelope, then each field independently) against a schema built dynamically from the matched type's field definitions. Low confidence falls back to `generic` with no fields, as today. The output wire format is explicit: an envelope (`type`, `confidence`) plus exactly one payload determined by the matched type — the existing `facts` array for the built-in temporal types, or an ordered `fields` array of `{ key, value }` pairs for operator-defined types. `fields` is an array, not an object, so duplicate keys survive parsing and can be dropped deterministically instead of being silently discarded. `profile`, `reference`, and `generic` carry no payload.
3. **Field scope**: operator-defined fields are document-level scalars, copied to all chunks (the `article` propagation model). Per-chunk source-range attribution remains exclusive to the built-in `event` type. No new columns, indexes, or storage per field — values flow through the existing metadata JSONB and metadata-rule scoring. The `chunks.date_from`/`date_to` trigger keys off the `dateFrom`/`dateTo` metadata keys and continues to work untouched.
4. **Field identity**: all field keys share one workspace-wide typed namespace. A key MAY be declared by more than one type (e.g. `price` on both "Product" and "Course"), but every declaration MUST carry the same value type — enforced at save time across the whole catalog. A field's key and value type are immutable once created; labels and extraction instructions are editable. Renaming or retyping a field means deleting it and creating a new key — two explicit operations, so retrieval rules and provenance are never silently re-pointed. Deleted keys are retired, not forgotten: the catalog tombstones every deleted key with its value type, and a key can only ever be recreated with its original value type — a saved retrieval rule can never end up pointing at a differently-typed field.
5. **Tag ownership**: extraction owns exactly the keys it generated for a document, recorded per document in enrichment provenance. It never overwrites metadata it does not own — manually authored and connector-supplied values win collisions, and a manual edit that changes or removes a generated key relinquishes extraction's ownership of that key in the same operation. Cleanup is atomic with success: only after validation succeeds does a run remove the previous generated keys, write the new set, and replace provenance, as one persisted update; a failed run records only the failure and leaves tags and the prior generated-key set intact.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Define a document type and extract its fields (Priority: P1)

An operator running a product-catalog workspace opens the catalog editor in **Knowledge → Ingestion** (alongside the workspace metadata-extraction toggle) and defines a "Product" document type: a short description of what a product page looks like, and fields `productName` (string), `price` (number), `category` (string), `availableFrom` (date). On the next (re)processing pass, documents matching that type carry those tags in their metadata, visible on the document detail page and as badges in document lists, with enrichment provenance showing which type matched and which keys were generated.

**Why this priority**: this is the whole feature — extraction stops being date-only without a code change per domain.

**Independent Test**: create a type with fields, ingest or reprocess a matching document, verify the tags in document metadata and the type key in enrichment provenance; verify a non-matching document classifies as `generic` with no operator fields.

**Acceptance Scenarios**:

1. **Given** a workspace with metadata extraction enabled and a "Product" type defined, **When** a product page is processed, **Then** its document and chunk metadata contain the defined field keys with values of the declared value types, and enrichment provenance records the matched type key, the catalog revision, and the exact set of generated keys.
2. **Given** the same workspace, **When** a document matching no defined type is processed, **Then** it is classified `generic`, no operator-defined fields are written, and processing succeeds.
3. **Given** the model returns a valid classification envelope whose `fields` array contains a valid entry, a value that fails its declared value type, an undeclared key, and two entries sharing one key, **When** enrichment completes, **Then** the valid entry and the first of the duplicated entries are applied, the others are dropped individually, the document is not failed, and provenance records applied and dropped counts without any document content.
4. **Given** an empty operator catalog with built-in types at their defaults, **When** documents are processed, **Then** classification behavior, written tags, and provenance are identical to today's built-in temporal extraction.
5. **Given** a document previously enriched as "Product", **When** the operator deletes the `category` field and the document is reprocessed, **Then** `category` is removed from its document and chunk metadata (it was in the previous generated-key set) and the remaining fields are extracted against the current catalog.
6. **Given** a document whose metadata already carries a manually authored `price`, **When** extraction matches a type declaring `price`, **Then** the manual value is preserved unchanged and the skipped collision is counted in provenance.
7. **Given** a document whose `price` tag was generated by a previous enrichment run, **When** an operator edits that value by hand and the document is later reprocessed, **Then** the manual edit removed `price` from the generated-key set, and the reprocess neither removes nor overwrites the hand-edited value — it is counted as a collision like any manually authored key.
8. **Given** an enrichment run whose model output is entirely unparseable, **When** the run fails, **Then** the document's existing tags, generated-key set, and last successful provenance survive unchanged apart from the recorded failure fields.
9. **Given** the catalog editor, **When** the operator declares a field key that duplicates an existing or retired key under a different value type, or uses a reserved key, or violates the key syntax (for example contains a dot), **Then** the save is rejected with a validation message naming the offending field.
10. **Given** the catalog editor, **Then** built-in types are listed read-only with their system-owned fields, each can be disabled except `generic`, and deleting a field or disabling a type warns (without blocking) when any agent's metadata rules reference an affected key.
11. **Given** two operators editing the catalog concurrently, **When** the second save arrives carrying a stale expected revision, **Then** it is rejected with a conflict response carrying the current revision, and no part of the first operator's save is silently overwritten.

---

### User Story 2 - Use extracted fields in retrieval rules (Priority: P2)

An operator opens the per-agent retrieve skill settings and adds a metadata rule on `category` or `price`. The rule editor's field autocomplete offers the union of declared catalog fields (built-in and operator-defined, typed with their declared value type) and the keys already observed on document metadata (manually authored or connector-supplied), so operators go from "extract a field" to "filter/boost on it" as one guided path without losing visibility of hand-set keys.

**Why this priority**: extraction without a retrieval consequence is inert; this closes the loop that makes US1 valuable. It also fixes the current suggestion plumbing — the observed-keys source (`backend/src/db/repositories/documentRepository.ts:158-176`) is not wired into the per-agent skill form (`SkillForm.tsx` passes `metadataFieldSuggestions={[]}`), so the per-agent editor has no autocomplete at all today.

**Independent Test**: with a catalog defining fields and a document carrying a manually authored key, open the per-agent metadata rules editor and verify both appear as suggestions — catalog fields with their declared types; create a filter rule on an extracted field and verify it constrains retrieval.

**Acceptance Scenarios**:

1. **Given** a catalog with declared fields, **When** the operator edits metadata rules on the retrieve skill, **Then** field suggestions list the declared fields with their declared value types, sourced from the catalog without scanning document metadata.
2. **Given** documents carrying manually authored metadata keys not declared in the catalog, **When** the operator edits metadata rules, **Then** those observed keys still appear as suggestions; where a key exists in both sources, the catalog's declared value type wins.
3. **Given** a filter rule on an extracted field, **When** a matching turn runs retrieval, **Then** candidates not carrying the required tag are excluded, as with any metadata rule today.

---

### Edge Cases

- **Deleting a type**: its tags persist on already-enriched documents until reprocess; on the next successful reprocess, the previous run's generated keys are removed and the current catalog is applied.
- **Provenance is current-state only**: `documents.enrichment` describes the run that produced the document's current tags (type key, catalog revision, generated keys, counts); a later successful run replaces it, and a failed run updates only the failure fields while preserving the last successful run's generated-key set and catalog revision. There is no per-document provenance history — change history is the catalog audit trail's job.
- **Deleting a field or disabling a type whose keys are referenced by agent metadata rules**: the editor warns but does not block; rules referencing keys that stop being generated simply stop matching, the same as any absent tag today.
- **Recreating a deleted key**: permitted only with the tombstoned identity's original value type; a different value type is rejected with a validation message naming the retired key.
- **Manual edit of a generated key**: changing or removing a generated key's value through the document metadata editor or API removes that key from the document's generated-key set in the same operation; from then on it is manually owned — never removed or overwritten by extraction, collisions counted.
- **Re-vectorized documents (new revision)**: a content change invalidates generated tags as today — they described the old content — and the follow-up enrich job re-extracts against the current catalog. Within an unchanged revision, tags are only ever replaced by a successful run.
- **Concurrent catalog edits**: every mutation carries the revision it was based on; a stale revision is rejected with a conflict response carrying the current one, so the second operator reloads instead of silently overwriting the first.
- **Reserved keys**: `dateFrom`, `dateTo`, and every key written by built-in types are reserved; the catalog editor rejects them for operator fields.
- **Key syntax**: operator field keys MUST match `^[A-Za-z][A-Za-z0-9_]{0,63}$`. Dots are prohibited: metadata-rule scoring interprets `.` as a nested-path separator (`metadataRuleScoringService.ts:104`), while extracted tags are written flat — a flat `"product.price"` tag would never match a rule.
- **Catalog bounds**: at most 20 operator-defined types and 10 fields per type; type descriptions ≤ 500 characters, field extraction instructions ≤ 240, labels ≤ 80, keys ≤ 64. The rendered catalog section of the classification prompt MUST NOT exceed 12,000 characters; a save that would exceed any bound is rejected at edit time with a message stating the limit. A runtime guard treats a persisted over-bound catalog (drift) as an enrichment failure with a content-free reason — never silent truncation.
- **Output bounds**: extracted string values are capped at 256 characters; total generated tags per document are capped at 8 KB serialized. Fields beyond a cap are dropped deterministically in catalog field order and counted in provenance. The existing completion-token ceiling of the enrichment call remains the hard output bound.
- **A document plausibly matching two types**: classification picks the single best type (no multi-type tagging).
- **Built-ins contract**: all five current shapes become built-in catalog entries — `event` and `article` with their system-owned temporal fields, `profile` and `reference` as field-less classification-only entries, and `generic` as the reserved fallback that is always present and cannot be disabled. Built-ins are visible, read-only, individually disableable (except `generic`), and enabled by default, so the default catalog classifies against exactly today's five shapes with identical provenance.

## Out of Scope

- **Per-source type pinning** (restricting classification for a source to selected types): deliberately excluded from this spec, including its data model and deletion semantics; it will be specified separately once the workspace catalog is in use.
- Multi-type classification of a single document.
- Per-chunk source-range attribution for operator-defined fields.
- Backfilling existing documents without an explicit reprocess.
- Per-field database columns or indexes.
- Performance changes to the observed-keys metadata scan (a pre-existing concern; this feature only stops depending on it as the sole suggestion source).

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: the type catalog is workspace settings data owned by a focused domain module with its own store; the enrichment domain (`backend/src/modules/documents/domain/enrichment/`) consumes it through a narrow read port (list enabled types with fields, plus the catalog revision). Transport stays in routes, orchestration stays in `documentProcessingService`, prompt templates stay under `backend/prompts/ingestion/`.
- **Encapsulation Rule**: `documentEnrichmentService` remains a single-call LLM adapter; building the classification prompt from type definitions and building the dynamic output schema are pure, separately tested domain helpers. `documentProcessingService` remains orchestration-only and MUST NOT learn catalog semantics beyond passing resolved types into the enrichment stage.
- **Cleanup Rule**: stale-tag removal MUST be driven by the generated-key set recorded in each document's enrichment provenance, not by hard-coded key lists. The current fixed `dateFrom`/`dateTo` strip in `documentProcessingService` generalizes to this mechanism behind the enrichment domain.
- **New Seams Required**: (1) a catalog read port consumed by enrichment and by the field-suggestion surface; (2) a dynamic output-schema builder that turns field definitions into the two-stage validation schema; (3) the metadata-rule field-suggestion provider composed from the catalog declarations and the existing observed-keys source, and plumbed into the per-agent skill form.
- **Anti-Goals**: no per-field database columns or indexes (dates keep their existing fast path; nothing else gets one until proven); no keyword lists or regexes for classification — type descriptions drive the LLM; no second LLM call per document; no per-chunk source-range attribution for operator-defined fields; no extraction logic in route handlers; no new storage system.
- **Contract review expectation**: the AMQP/queue message contract stays unchanged. The enrich job resolves the catalog at execution time through the read port — decided here, not deferred: "subsequent processing" means every job that executes after a catalog change sees the new catalog, and provenance records which revision a run actually used, so in-flight jobs at the moment of an edit are observable rather than ambiguous. No catalog data rides on job payloads.
- **Public API impact**: catalog routes and the extended enrichment provenance are public API changes; the plan MUST include the OpenAPI schema updates and the regenerated `typescript-sdk` snapshot (`cd typescript-sdk && pnpm run sync`) in the same change, per the repo contract rule.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Operators MUST be able to create, edit, disable, and delete workspace-level document type definitions, each with a key, label, natural-language classification description, enabled flag, and an ordered list of field definitions. Built-in entries are system-owned and read-only; `generic` is reserved, always present, and cannot be disabled.
- **FR-002**: Each field definition MUST declare a key, label, value type from the existing metadata-rule enum (`string|number|date|boolean`), and a natural-language extraction instruction. Field keys share one workspace-wide namespace: declarations of the same key across types MUST agree on value type, validated across the whole catalog on every save. A field's key and value type are immutable after creation; label and instruction remain editable. Deleting a field tombstones its identity (key + value type) in the catalog; recreating a tombstoned key MUST be permitted only with its original value type.
- **FR-003**: Operator field keys MUST match `^[A-Za-z][A-Za-z0-9_]{0,63}$` (dots prohibited — extracted tags are flat while rule matching treats `.` as a path separator), and MUST NOT collide with reserved keys written by built-in types (`dateFrom`, `dateTo`, and any future built-in key).
- **FR-004**: The catalog MUST carry a monotonically increasing revision, bumped on every mutation. Mutations MUST be conditional writes carrying the revision they were based on, and MUST be rejected with a conflict response (returning the current revision) when it is stale — two operators can never silently overwrite each other.
- **FR-005**: The enrichment stage MUST classify each document against the enabled catalog types plus the reserved fallback `generic`, in a single LLM call per document.
- **FR-006**: The model output contract MUST be an envelope (`type`, `confidence`) plus exactly one payload keyed to the matched type: the existing `facts` array for built-in temporal types, or an ordered `fields` array of `{ key, value }` pairs for operator-defined types. `fields` MUST be an array — never an object — so duplicate keys survive parsing and are droppable deterministically.
- **FR-007**: Output validation MUST be two-stage. Stage 1 validates the classification envelope: an unknown or invalid type key falls back to `generic` with no fields and a content-free provenance note; entirely unparseable output records an enrichment failure without touching the document's tags, generated-key set, or last successful provenance. Stage 2 validates each `fields` entry independently: undeclared keys are dropped, values failing their declared value type are dropped, entries duplicating an earlier key are dropped (first occurrence wins), and declared-but-missing fields are simply absent. No per-field drop fails the document, and every drop is counted content-free in provenance.
- **FR-008**: Valid extracted values MUST be written as flat scalar tags to `documents.metadata` and propagated to `chunks.metadata`, idempotently per document revision, preserving the existing stale-revision and never-fail-the-document guarantees.
- **FR-009**: Extraction MUST NOT overwrite metadata keys it does not own: a key already present that is not in the document's generated-key set is skipped and the collision counted in provenance. Tag replacement MUST be atomic with success: only after validation succeeds are the previous run's generated keys removed, the new tags written, and provenance replaced — as one persisted update. A failed run MUST record only its failure fields, leaving existing tags and the prior generated-key set intact for future cleanup. A new document revision invalidates generated tags as today, since the content they described has changed.
- **FR-010**: A manual metadata write (document editor or API) that changes or removes a key present in the document's generated-key set MUST remove that key from the set in the same operation, relinquishing extraction ownership so subsequent runs treat it as manually authored.
- **FR-011**: Enrichment provenance (`documents.enrichment`) MUST record the matched type key, the catalog revision used, the exact set of generated keys, and counts of applied, dropped (invalid, undeclared, duplicate, over-cap), and collision-skipped fields — all content-free. Provenance is current-state only: it describes the most recent completed run, a failed run updates only failure fields while preserving the last successful run's generated-key set and catalog revision, and no per-document history is retained.
- **FR-012**: The built-in temporal behavior (`event`, `article` shapes, `dateFrom`/`dateTo`, per-chunk event attribution, `chunks.date_from`/`date_to` maintenance, structured temporal lookup) MUST be preserved unchanged. With an empty operator catalog and built-ins at their defaults, the classification set, written tags, and provenance MUST be identical to today.
- **FR-013**: Metadata-rule field suggestions MUST be the union of catalog declarations (built-in and operator-defined, with declared value types) and keys observed on document metadata, deduplicated by key with the catalog's value type winning conflicts — and MUST be available in the per-agent retrieve skill settings editor.
- **FR-014**: Catalog bounds (type count, fields per type, description/instruction/label/key lengths, rendered prompt budget) MUST be enforced at save time with limit-naming validation errors; the runtime MUST guard against persisted over-bound catalogs by recording a content-free enrichment failure rather than truncating silently.
- **FR-015**: Extracted output bounds (per-value length, total serialized size) MUST be enforced with deterministic drop order (catalog field order) and drops counted in provenance.
- **FR-016**: Catalog changes MUST take effect on subsequent processing only — the enrich job resolves the catalog at execution time; the existing reprocess actions (source-level and document-level) MUST apply the current catalog, including generated-key cleanup, to existing documents.
- **FR-017**: Catalog mutations MUST require the same permission that governs workspace ingestion settings; the catalog MUST be readable by any member permitted to view knowledge settings.
- **FR-018**: The catalog editor MUST warn — without blocking — when deleting a field or disabling a type whose keys are referenced by any agent's metadata rules.
- **FR-019**: The catalog management surface MUST ship with a copilot tool descriptor, or a stated coverage-map exclusion, per the operator-facing feature rule.
- **FR-020**: Catalog mutations MUST emit audit events; enrichment observability MUST include the matched type key and drop/collision counts and MUST NOT include document content, prompts, or extracted values.

### Key Entities

- **Document Type Catalog**: workspace-scoped; holds the monotonically increasing revision (conditional-write concurrency token), the operator-defined type definitions, the built-in entries (`event`, `article`, `profile`, `reference`, plus the reserved `generic` fallback), and the tombstoned identities of deleted field keys.
- **Document Type Definition**: key, label, classification description, enabled flag, ordered field definitions; built-in entries are system-owned and read-only.
- **Field Definition**: key, label, value type (`string|number|date|boolean`), extraction instruction; belongs to a type definition; key and value type immutable, with key/value-type consistency enforced workspace-wide across live and tombstoned identities.
- **Enrichment Provenance** (existing, extended): gains the matched type key, catalog revision, generated-key set, and applied/dropped/collision counts; current-state only, replaced atomically by successful runs, failure fields updated in place by failed ones.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can go from defining a new document type to filtering retrieval on one of its extracted fields entirely through settings — zero code changes, zero support involvement.
- **SC-002**: Call count is unchanged: exactly one model call per processed document. Prompt overhead is bounded and measurable: the rendered catalog section adds at most 12,000 characters on top of the existing 48,000-character document representation cap, and the completion-token ceiling of the enrichment call is unchanged.
- **SC-003**: All existing temporal-extraction and temporal-retrieval tests and evals pass unchanged with an empty operator catalog and built-ins at their defaults.
- **SC-004**: The per-agent metadata rules editor shows typed suggestions for every declared catalog field without a document-metadata scan, and keys observed on manually authored metadata continue to appear — no autocomplete regression relative to the observed-keys source.
- **SC-005**: The deterministic eval-suite fixtures (normal CI) cover and pass: classification to an operator-defined type with field application, `generic` fallback for a non-matching document, per-field drop behavior on invalid output (including duplicate `fields` entries), collision preservation of manually authored metadata, ownership relinquishment after a manual edit of a generated key, and tag survival across a failed run.
