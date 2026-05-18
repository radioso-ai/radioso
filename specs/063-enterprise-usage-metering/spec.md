# Feature Specification: Enterprise Usage Metering

**Feature Branch**: `063-enterprise-usage-metering`  
**Created**: 2026-05-18  
**Status**: Approved  
**Input**: User description: "Define customer-facing and internal enterprise usage metering for indexed storage, recurring website crawls, embedding/model consumption, and usage-limit enforcement."

**Scope Note**: This is an umbrella specification. Implementation should be split into smaller delivery specs or branches for storage-byte accounting, recrawl semantics, and internal model-usage ledger work rather than landed as one large change.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand Customer-Facing Consumption (Priority: P1)

As an enterprise customer or account admin, I want simple usage metrics that explain what my account is consuming so I can understand plan limits without learning Radioso's internal model-provider or indexing implementation.

**Why this priority**: Billing and caps must match the customer's mental model. Counting documents alone treats a 5-byte note and a 5 MB document equally and does not explain website recrawl or embedding consumption.

**Independent Test**: Can be tested by creating documents, importing files, crawling websites, and fetching the account usage API to verify customer-facing meters are present and understandable.

**Acceptance Scenarios**:

1. **Given** an account has uploaded files, inline documents, and crawled website pages, **When** account usage is fetched, **Then** usage reports current indexed storage bytes, monthly indexed content bytes, and monthly answers.
2. **Given** a customer has many tiny documents, **When** account usage is fetched, **Then** document count is shown only as secondary context or a guardrail and storage bytes remain the primary storage metric.
3. **Given** a profile has no configured byte limit, **When** usage is fetched, **Then** the relevant byte meter returns `limit: null` while still reporting current usage.

---

### User Story 2 - Treat Website Recrawls As Refreshes, Not Duplicate Storage (Priority: P1)

As an enterprise customer using website crawling, I want recrawls to update the current indexed corpus rather than count as duplicate stored content so the storage meter reflects what Radioso currently keeps searchable.

**Why this priority**: Crawled websites will likely be a large share of stored content, and recurring crawl refreshes are expected product behavior.

**Independent Test**: Can be tested by crawling the same website page multiple times with stable external document IDs and verifying storage usage reflects the current page size, not cumulative crawl history.

**Acceptance Scenarios**:

1. **Given** a crawled page already exists at 50 KB, **When** a recrawl updates that page to 70 KB, **Then** stored indexed bytes increase by 20 KB.
2. **Given** a crawled page already exists at 70 KB, **When** a recrawl updates that page to 50 KB, **Then** stored indexed bytes decrease by 20 KB and the update is allowed even if the account is currently at the storage cap.
3. **Given** a recrawl returns the same normalized content hash for a page, **When** processing completes, **Then** the page is not re-embedded and monthly indexed content usage does not increase.
4. **Given** a full recrawl no longer finds a previously indexed page, **When** source sync completes successfully, **Then** the missing page is removed from the active indexed corpus and stored indexed bytes decrease accordingly.

---

### User Story 3 - Meter Indexing And Model Consumption Internally (Priority: P1)

As a Radioso operator, I want every embedding and model call recorded with provider, model, token, byte, and lineage metadata so internal aggregates and cost analysis can be derived reliably.

**Why this priority**: Enterprise caps can be simple, but operational cost control requires accurate internal accounting for embeddings, answers, query rewrites, reranking, crawler indexing, and other model-backed work.

**Independent Test**: Can be tested by running embedding and answer flows, then querying the immutable usage ledger and rollups for matching event records and aggregate totals.

**Acceptance Scenarios**:

1. **Given** document processing embeds chunks for a document revision, **When** embedding succeeds, **Then** a usage event records account, workspace, document, revision, provider, model, input bytes, token usage, vector count, status, and usage quality.
2. **Given** the embedding provider does not return token usage, **When** usage is recorded, **Then** Radioso stores an estimated token count and marks the event as estimated.
3. **Given** an assistant or retrieval answer uses a model, **When** the request completes, **Then** a model usage event records the answer operation, model, provider, input tokens, output tokens, total tokens, and status.
4. **Given** a model call is retried with the same idempotency key, **When** usage is recorded again, **Then** the ledger does not double count the operation.

---

### User Story 4 - Enforce Limits Before Expensive Work (Priority: P1)

As a Radioso operator, I want enterprise limits enforced before storage growth, embedding, and answer generation so customers cannot race past caps through concurrent uploads, crawls, or chat traffic.

**Why this priority**: Metering without pre-work reservations does not protect provider spend, database growth, or worker capacity.

**Independent Test**: Can be tested with concurrent ingestion/crawl/chat requests near configured limits and verifying only requests within the available reservation budget proceed.

**Acceptance Scenarios**:

1. **Given** an account has a stored indexed byte cap, **When** a new document would exceed the cap, **Then** ingestion is rejected before queued processing or embedding work starts.
2. **Given** an account has a monthly indexed content cap, **When** a changed crawled page would exceed the period budget, **Then** indexing is rejected before embedding work starts.
3. **Given** multiple uploads or crawled pages arrive concurrently, **When** their combined reserved bytes exceed the account cap, **Then** only reservations within the cap are allowed.
4. **Given** answer usage is exhausted, **When** an assistant or retrieval answer is requested, **Then** the request is rejected before model generation.

### Edge Cases

- What happens when an imported file is stored successfully but document persistence fails?
- What happens when document processing fails after indexing usage was reserved?
- What happens when a crawl page changes size while another crawl for the same source is already processing?
- What happens when a provider returns usage in a different shape or omits token usage?
- What happens when old documents do not have persisted byte-size metadata?
- What happens when a usage event is recorded but rollup update fails?
- What happens when a deleted or stale website page is still retained for audit or rollback?
- What happens when customers have many tiny documents that create high row, chunk, queue, or listing overhead despite low byte usage?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and TypeScript.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, persistence, and deployment-specific enterprise adapters.
- Runtime LLM prompt templates, if any are introduced by follow-on work, MUST live under `backend/prompts/`.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings.
- Public contract changes MUST update the code-first OpenAPI registry, generated OpenAPI artifacts, SDK types, and relevant docs.
- Contract changes MUST include message-queue impact review for document worker payloads, crawler job payloads, retry semantics, AMQP queue behavior, and queue docs/tests.
- Documentation that explains enterprise usage, setup, APIs, ingestion, retrieval settings, SDK usage, or MCP usage MUST be updated in the same change.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Customer-facing usage policy belongs in the EE usage-limit module; immutable usage capture belongs behind a focused metering port; provider adapters report model usage at the provider boundary; document and crawler services pass lineage and byte context without owning billing policy.
- **Encapsulation Rule**: Route handlers, crawler orchestration, document processing, retrieval orchestration, and chat services MUST NOT format billing records directly or contain provider-specific cost math. They may reserve usage through a narrow policy port and record usage through a narrow metering port.
- **Source Of Truth Rule**: Current storage usage is derived from active document state. Work performed by models and embeddings is derived from the immutable usage-event ledger. Daily rollups are derived caches and MUST NOT be the authoritative record. Live reservations are authoritative only for concurrent enforcement decisions.
- **Recrawl Rule**: Website recrawls with stable source and external document IDs update the current indexed page representation. Storage accounting is delta-based against the existing active page. Indexing accounting is work-based and counts changed content that is re-indexed. For crawled pages, exact bytes are known after fetch, extraction, and normalization, so reservations happen post-extraction and before document commit, queue dispatch, and embedding work.
- **New Seams Required**: Introduce a dedicated usage event recorder port, for example `UsageEventRecorder` or `UsageMeteringSink`, separate from the reservation/enforcement policy. Introduce explicit reservation methods such as `reserveIndexedStorage` and `reserveMonthlyIndexedContent` instead of mutating the existing document-count reservation into a byte meter. Add a document byte-size field, model usage recorder, indexing usage recorder, and EE ledger/rollup persistence.
- **Anti-Goals**: Do not use document count as the primary customer-facing storage meter. Do not bill storage cumulatively for repeated recrawls of the same active page. Do not make rollups the only source of usage truth. Do not embed provider-specific billing prices into product workflow services. Do not record raw prompts, raw document bodies, raw chunk text, secrets, session material, or connector credentials in usage events.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Account usage MUST expose customer-facing meters for current indexed storage bytes, monthly indexed content bytes, and monthly answers.
- **FR-002**: Account usage MAY expose stored document count as secondary context or a technical guardrail, but document count MUST NOT be the primary customer-facing storage meter.
- **FR-003**: Usage profiles MUST support `storedIndexedByteLimit`, `monthlyIndexedByteLimit`, and `monthlyAnswerLimit`.
- **FR-004**: Usage profiles MAY retain `storedDocumentLimit` as an operational guardrail for excessive row, chunk, queue, and listing overhead.
- **FR-005**: Documents MUST persist a reliable `content_size_bytes BIGINT` field for customer-facing indexed storage accounting.
- **FR-006**: Uploaded files MUST set document byte size from the original stored file size.
- **FR-007**: Inline documents MUST set document byte size from the UTF-8 byte length of the sanitized indexed content.
- **FR-008**: Crawled website pages MUST set document byte size from the UTF-8 byte length of normalized extracted content that Radioso stores and retrieves from.
- **FR-009**: Existing documents without byte-size metadata MUST be backfilled from `source_size_bytes` when present, otherwise from `OCTET_LENGTH(source_content)`.
- **FR-010**: Customer-visible current stored indexed bytes MUST be computed from active documents only. Active storage reservations MUST be added only for enforcement comparisons against the cap, not exposed as current usage to customers.
- **FR-011**: Recrawling an existing page with the same workspace, source, and external document ID MUST reserve only `max(newBytes - oldBytes, 0)` against stored indexed byte limits.
- **FR-012**: Recrawling an existing page that shrinks MUST be allowed even when the account is at the stored indexed byte cap.
- **FR-013**: Recrawling unchanged content identified by a stable normalized content hash scoped to the same workspace, source, and external document ID MUST skip re-embedding when safe and MUST NOT increment monthly indexed content usage.
- **FR-014**: Changed or newly indexed content MUST increment monthly indexed content usage by the full new normalized content byte size, not only the storage delta.
- **FR-015**: A successful full website recrawl MUST remove pages that are no longer found from the active indexed corpus. Configurable retention of stale pages is out of scope for this feature.
- **FR-016**: The system MUST record immutable usage events for every embedding call and every model-backed operation Radioso wants to aggregate internally.
- **FR-017**: Usage events MUST include account, workspace, operation, surface, provider, model, token counts, byte counts, status, usage quality, occurrence time, and an idempotency key.
- **FR-018**: Usage events SHOULD include source, document, document revision, conversation, message, job, provider request ID, and error code when available.
- **FR-019**: Embedding usage MUST include document/chunk lineage sufficient to aggregate usage by document revision and source.
- **FR-020**: Provider-reported token counts MUST be stored as actual usage when available.
- **FR-021**: Estimated token counts MUST be stored when provider-reported usage is unavailable, and the event MUST identify usage quality as estimated.
- **FR-022**: Usage event recording MUST be idempotent for retries and duplicate delivery.
- **FR-023**: Daily usage rollups MUST be derivable from the immutable ledger and MUST support account, date, operation, provider, and model aggregation.
- **FR-024**: Rollup failures MUST NOT erase or alter immutable ledger records.
- **FR-025**: Limit enforcement MUST reserve stored indexed bytes before creating or replacing active document content that would grow storage.
- **FR-026**: Limit enforcement MUST reserve monthly indexed content before dispatching or performing embedding work for new or changed content.
- **FR-027**: Limit enforcement MUST reserve monthly answer usage before assistant or retrieval model generation.
- **FR-028**: Customer-facing storage and indexing reservations MUST be released when the corresponding customer-visible indexing attempt fails before commit.
- **FR-029**: Internal failed model or embedding attempts MUST still be recordable in the usage ledger for cost and reliability analysis.
- **FR-030**: Usage APIs MUST preserve backward compatibility for existing EE usage-limit clients by making new fields additive during rollout.
- **FR-031**: The implementation MUST include tests for concurrent reservations so storage and indexing limits cannot be exceeded by parallel uploads, crawls, or worker dispatch.
- **FR-032**: Public docs MUST explain the customer-facing mental model: indexed storage is current active corpus size, monthly indexed content is content added or refreshed during the period, and answers are generated assistant or retrieval responses.
- **FR-033**: Usage reservations MUST be idempotent by work item or have a strict release-on-error path plus TTL cleanup so retries cannot permanently double-reserve usage.
- **FR-034**: Usage event idempotency keys MUST be deterministic per operation surface. Embedding keys SHOULD include workspace, document, revision, chunk or batch identity, provider, and model. Answer keys SHOULD include conversation or request identity, message identity when available, provider, model, and attempt identity.
- **FR-035**: Public OpenAPI, SDK types, and usage-limit route tests MUST be updated for the additive usage fields.

### Key Entities *(include if feature involves data)*

- **Customer Usage Meter**: A product-facing usage dimension exposed to customers and used for plan limits, such as indexed storage, monthly indexed content, and monthly answers.
- **Document Byte Size**: The persisted byte count for the active indexed representation of a document, file, or crawled page.
- **Storage Reservation**: A short-lived reservation that prevents concurrent ingestion or recrawl operations from exceeding stored indexed byte caps.
- **Indexing Reservation**: A short-lived reservation that prevents concurrent processing or recrawl operations from exceeding monthly indexed content caps before embedding work begins.
- **Usage Event**: An immutable internal record of model or embedding work with provider, model, token, byte, lineage, and status metadata.
- **Embedding Usage Item**: A usage-event child record that links embedding work to document revisions and chunks.
- **Usage Rollup**: A derived aggregate of usage events for fast internal reporting and account usage APIs.
- **Website Source**: A document source representing a crawled website. Pages under a website source are identified by stable external document IDs.

## Data Model Direction

The implementation SHOULD add `content_size_bytes BIGINT` to `documents` and SHOULD backfill it from existing data. The name deliberately avoids `billable_*` because pricing is out of scope and customer-visible billing semantics should not leak into the core document schema.

The EE module SHOULD add immutable ledger tables equivalent to:

```sql
ee_usage_events (
  id UUID PRIMARY KEY,
  idempotency_key TEXT UNIQUE NOT NULL,
  account_id UUID,
  workspace_id UUID,
  source_id UUID,
  document_id UUID,
  document_revision INTEGER,
  conversation_id UUID,
  message_id UUID,
  job_id UUID,
  surface TEXT NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  input_bytes BIGINT NOT NULL DEFAULT 0,
  output_bytes BIGINT NOT NULL DEFAULT 0,
  vector_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  usage_quality TEXT NOT NULL,
  provider_request_id TEXT,
  error_code TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
```

The EE module SHOULD add embedding lineage records equivalent to:

```sql
ee_embedding_usage_items (
  usage_event_id UUID NOT NULL REFERENCES ee_usage_events(id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  document_revision INTEGER NOT NULL,
  chunk_id UUID,
  chunk_index INTEGER,
  content_bytes BIGINT NOT NULL,
  estimated_tokens BIGINT,
  PRIMARY KEY (usage_event_id, document_id, document_revision, chunk_index)
)
```

The EE module SHOULD add daily rollups equivalent to:

```sql
ee_usage_daily_rollups (
  account_id UUID NOT NULL,
  usage_date DATE NOT NULL,
  operation TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  total_tokens BIGINT NOT NULL DEFAULT 0,
  input_bytes BIGINT NOT NULL DEFAULT 0,
  output_bytes BIGINT NOT NULL DEFAULT 0,
  vector_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, usage_date, operation, provider, model)
)
```

The exact table and column names may change during implementation, but the source-of-truth, idempotency, lineage, and rollup semantics MUST remain intact.

Storage-byte enforcement should follow the existing EE usage-limit pattern used by document-count reservations in `EnterpriseUsageLimitService`: lock account usage, clean expired reservations, compute persisted usage, add active reservations for enforcement only, and create a TTL-bound reservation row.

## Source Of Truth And Read Paths

- **Customer-visible storage usage**: active document rows summed by `content_size_bytes`.
- **Storage enforcement**: active document rows plus active storage reservations.
- **Customer-visible monthly indexing usage**: usage ledger or rebuilt rollup for committed indexing work, plus open indexing reservations only when the UI intentionally wants to show pending work.
- **Indexing enforcement**: period usage plus active indexing reservations.
- **Internal billing/audit**: immutable usage ledger.
- **Fast reporting**: daily rollups derived from the ledger and rebuildable at any time.

## API Direction

Account usage responses SHOULD add fields equivalent to:

```ts
{
  storedIndexedBytes: {
    used: number;
    limit: number | null;
  };
  monthlyIndexedBytes: {
    periodStart: string;
    resetAt: string;
    used: number;
    limit: number | null;
  };
  monthlyAnswers: {
    periodStart: string;
    resetAt: string;
    used: number;
    limit: number | null;
  };
  storedDocuments: {
    used: number;
    limit: number | null;
  };
}
```

Profile write APIs SHOULD accept byte limits as integers in bytes. UI and documentation may display MB, GB, or other human-readable units, but persisted and API contract units MUST be bytes.

## Delivery Split

Implementation SHOULD be split into smaller, reviewable scopes:

1. **063a - Indexed Storage Bytes**: add `content_size_bytes`, backfill existing documents, add indexed-storage reservation enforcement, expose stored indexed bytes, and preserve document count as a guardrail.
2. **063b - Website Recrawl Accounting**: apply delta storage reservations for crawled pages, skip unchanged content by scoped normalized content hash, and remove stale pages from the active indexed corpus after successful full recrawls.
3. **063c - Model Usage Ledger**: add the EE immutable usage ledger, usage event recorder port, provider-boundary model usage recording, embedding lineage records, monthly indexed content enforcement, and rebuildable rollups.

## Assumptions

- The existing EE usage-limit module is the right home for customer-facing limit policy and profile assignment.
- A new or extended shared port is needed so OSS remains no-op by default while EE can provide durable usage metering.
- Current indexed storage should be based on content Radioso stores and retrieves from, not on transient raw HTML, CSS, JavaScript, screenshots, or fetched assets unless those become stored searchable artifacts.
- Monthly indexed content is a work meter, so changed recrawled content counts even when it replaces an existing active page.
- Pricing is out of scope. This spec defines metering and enforcement primitives, not price tables.
- Recrawl bandwidth and crawler provider request limits are out of scope for this spec unless later captured as a separate crawl-activity meter.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Account usage can report current indexed storage bytes, monthly indexed content bytes, monthly answers, and secondary stored document count for an enterprise account.
- **SC-002**: Recrawling an existing crawled page updates active storage usage by byte delta and does not cumulatively count historical copies.
- **SC-003**: Changed crawled content increments monthly indexed content usage, while unchanged content hash recrawls do not trigger re-embedding or indexing usage.
- **SC-004**: Every successful embedding operation creates an idempotent usage ledger record with provider, model, bytes, tokens or estimated tokens, vector count, and document revision lineage.
- **SC-005**: Every model-backed answer operation creates an idempotent usage ledger record with provider, model, input tokens, output tokens, total tokens, and status.
- **SC-006**: Concurrent ingestion and crawl operations cannot exceed stored indexed byte caps or monthly indexed content caps.
- **SC-007**: EE integration tests prove usage rollups can be rebuilt from immutable usage events and match ledger aggregates for tested periods.
- **SC-008**: Existing EE usage-limit API consumers continue to work during rollout because new fields are additive.
