# Feature Specification: Model and Embedding Usage Visibility

**Feature Branch**: `usage-model-telemetry-tab`
**Spec**: `955-usage-model-telemetry-tab`
**Created**: 2026-08-03
**Status**: Approved
**Input**: User description: "We are recording telemetry and model usage, but cannot see it. Add a Usage tab that displays per-message input, reasoning, and output tokens, plus internal model and embedding operations such as agent creation, test chat, directive analysis, and metadata generation."

## Clarifications

### Session 2026-08-03

- Metadata generation is an internal operation and is presented as **Metadata generation**, not by its implementation-only operation key.
- Dashboard test chat and workbench/eval replay are internal usage, even when their events have message lineage.
- Durable job or multi-document batch grouping is deliberately deferred. This feature must not infer a batch relationship from time, source, or document IDs.
- Directive coherence is an internal operation. Its model invocation must carry the real workspace and agent attribution before it can be recorded; a synthetic workspace identifier is not acceptable because it cannot satisfy ledger foreign keys.
- A durable ledger event kind distinguishes **model**, **embedding**, and irreducibly **unknown historical** records. New writes are always model or embedding; reporting uses the persisted kind, not a vector count or a display label.
- Reasoning coverage is explicit. An aggregate with some known reasoning counts and some unavailable counts is **partial**; it must not invent a visible-output value from incomplete data.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explain a visitor message's AI usage (Priority: P1)

As an account member, I want to inspect the model usage caused by each end-user message so I can understand why a conversation used a particular amount of AI capacity.

**Why this priority**: One user-visible turn can trigger planning, retrieval, directive, agent, and answer calls. Aggregate trends cannot explain that total.

**Independent Test**: Seed a visitor conversation whose message produces several model-usage events, then open Usage > AI usage > Messages and confirm that one message row shows the complete token breakdown without exposing message content.

**Acceptance Scenarios**:

1. **Given** an end-user message that triggers several succeeded model calls, **When** a member opens the Messages view, **Then** the member sees one row for that message with aggregate model input, reasoning, completion, visible-output when determinable, and total token counts.
2. **Given** a provider reports separate reasoning usage, **When** the corresponding message is displayed, **Then** reasoning is shown separately and is not double-counted as visible output.
3. **Given** a provider or historical event did not report separate reasoning usage, **When** the message is displayed, **Then** the reasoning value is clearly shown as unavailable rather than presented as a fabricated zero.
4. **Given** a message has failed and succeeded model attempts, **When** it is displayed, **Then** the row communicates the attempt status/counts and preserves any recorded usage from both attempts.
5. **Given** a message mixes calls with reported and unavailable reasoning usage, **When** it is displayed, **Then** it identifies reasoning coverage as partial, shows the provider completion total, and does not present a falsely precise visible-output total.
6. **Given** a retrieval query embedding is linked to an end-user message, **When** the message is displayed, **Then** its embedding input tokens and vector count appear in a separate embedding subtotal and do not make the model reasoning coverage partial or unavailable.

---

### User Story 2 - Inspect internal model and embedding work (Priority: P1)

As an account member, I want to see internal AI operations separately from end-user traffic so I can diagnose background and operator-driven usage.

**Why this priority**: Metadata generation, embeddings, agent setup, directive drafting/coherence, operator test chat, and evaluation work can materially affect usage but do not belong in a visitor-message report.

**Independent Test**: Seed model and embedding usage for metadata generation, an operator test chat, an eval, and an embedding operation, then confirm each appears in Internal operations with the right category and resource counts.

**Acceptance Scenarios**:

1. **Given** a metadata-generation model call, **When** a member opens Internal operations, **Then** it is listed as Metadata generation with its provider, model, token breakdown, quality, and status.
2. **Given** an embedding operation, **When** it is listed, **Then** the member can see its input-token usage, vector count, provider, model, quality, and status without an invented output or reasoning value.
3. **Given** a dashboard test chat, workbench replay, or eval run, **When** its events are displayed, **Then** they appear in Internal operations rather than Messages.
4. **Given** a newly recorded internal operation that is not among the named examples, **When** it is displayed, **Then** the member can still identify it by a safe, human-readable surface and operation label.
5. **Given** an agent-setup, directive-draft, or directive-coherence call, **When** it is displayed, **Then** it is respectively labeled Agent setup, Draft directive, or Directive coherence rather than being mislabeled as a generic operation.

---

### User Story 3 - Narrow a usage investigation safely (Priority: P2)

As an account member, I want to narrow AI usage by time range and workspace so I can investigate a specific period without seeing another account's data or sensitive model inputs.

**Why this priority**: The detailed ledger can become large and contains operationally sensitive metadata, so it needs bounded, account-scoped access.

**Independent Test**: Request each detailed view with a known account/workspace and cursor, then confirm stable pagination, matching filters, and rejection of a workspace owned by another account.

**Acceptance Scenarios**:

1. **Given** a member selects a valid workspace and date range, **When** the detailed views load, **Then** only matching account usage is returned in stable newest-first pages. Message rows are aggregated before a page is selected, rather than grouping a partially paged event set.
2. **Given** a member selects another account's workspace ID, **When** the request is made, **Then** it is rejected without returning usage data.
3. **Given** no matching events exist, **When** a detailed view loads, **Then** it shows a clear empty state rather than an error.
4. **Given** a usage record contains prompt, completion, document, or credential data elsewhere in the system, **When** detailed usage is displayed, **Then** none of that content is included in the API response or UI.

### Edge Cases

- New records must retain a nullable reasoning-token value when the provider does not expose a separate count; `0` means a reported zero, while unavailable remains distinguishable.
- Historical records lack durable reasoning-token data and must not be backfilled from an estimate.
- A zero-vector embedding attempt remains an embedding event because the durable event kind, not `vector_count`, controls its type.
- A historical row whose persisted data cannot distinguish model from embedding remains `unknown historical usage`; it is never silently forced into a model or embedding subtotal.
- Message-linked embeddings remain in the same message summary as the visitor turn, but their input tokens/vector count are separate from the model token breakdown and do not participate in reasoning coverage.
- A deleted message or conversation can remove lineage from a usage event. Such records remain visible as internal/unattributed usage rather than being silently dropped.
- All recorded attempts are visible for diagnostics. The detailed views must show status and usage quality so a failed or estimated attempt is not mistaken for a successful, provider-reported one.
- This feature does not add a durable ingestion run, processing batch, or grouping key across documents. Metadata-generation records remain individual usage events.
- Detailed responses use a strict allowlist. In addition to content and credentials, they never expose `idempotency_key`, `provider_request_id`, or `error_code`, because those fields can carry sensitive request or error detail.

## Constitution Constraints *(mandatory)*

- Implementation begins only after this written specification is approved by the requestor.
- Backend work uses Node.js and TypeScript; the dashboard uses React; persistent data remains in PostgreSQL with pgvector.
- Backend changes follow TDD: focused tests are written and observed failing before implementation changes make them pass.
- The UI reuses the existing authenticated dashboard design system and follows the established dark-theme tokens and interaction patterns.
- The feature must preserve the boundary between HTTP transport, reporting orchestration, ledger persistence, provider usage extraction, and dashboard presentation.
- Customer data is protected with active-account membership checks and by excluding prompts, completions, message bodies, document/chunk text, credentials, cookies, and connection strings.
- HTTP contract changes update the code-first OpenAPI registry and regenerated OpenAPI artifacts; the browser-session account API is not added to the API-key TypeScript SDK.
- User-visible behavior receives Playwright coverage. Frontend unit tests remain limited to non-visual query, pagination, and formatting logic.
- Relevant operator/API documentation is updated with the implementation.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Provider adapters own provider-specific usage extraction. The shared inference pipeline normalizes and records an immutable usage event. The reporting module owns account-scoped classification, aggregation, pagination, and response contracts. The dashboard owns filters, loading/error/empty states, and presentation only.
- **Encapsulation Rule**: `usage_events` remains the source of truth. Route handlers must not contain SQL or classify operations; provider adapters must not know about dashboard labels; `usage-view.tsx` remains a page-level composer rather than absorbing table/query logic.
- **New Seams Required**: Add a focused detailed-usage reporting port/read model alongside trends, with separate message-summary and internal-event response shapes. Message summaries partition model, embedding, and unknown-historical subtotals. Add nullable reasoning-token propagation and a durable model/embedding event kind to the ledger path, with `unknown` available only for ambiguous migrated history. Add a narrow directive-coherence attribution input so its model gateway receives real workspace and agent context. Keep message/internal classification in a pure reporting helper that consumes recorded lineage rather than a hard-coded list of English operation names.
- **Dependency Direction**: Reporting depends on the usage ledger's read shape and account-access port; it does not reach into chat, document, or provider services. Dashboard components depend on frontend API adapters and response types; they do not query the database or reproduce server-side classification.
- **Anti-Goals**: Do not create a parallel telemetry store, infer a cross-document batch/job ID, expose raw user or document content, hard-code a closed taxonomy of operations, mix cost/pricing policy into this diagnostic view, or change worker queue payloads.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Usage page MUST provide a clearly labeled AI usage tab while retaining the existing usage overview and trends.
- **FR-002**: The AI usage tab MUST provide distinct Messages and Internal operations views.
- **FR-003**: The Messages view MUST aggregate usage events into one row per message, ordered by most recent recorded activity, only when the event joins to a message with role `user`, that message joins to a conversation whose source is not `authenticated_chat` or `workbench_replay`, and the event is not eval-attributed.
- **FR-004**: The Messages view MUST aggregate and rank full message groups before it applies keyset pagination. Its cursor MUST contain a deterministic tie-breaker for rows sharing the same most-recent activity time.
- **FR-005**: The Internal operations view MUST show individual recorded model, embedding, and unknown-historical attempts that do not meet the Messages predicate, including unattributed records, deleted-lineage records, operator tests, evals, metadata generation, and newly added operation types.
- **FR-006**: Each message summary MUST partition its totals by durable event kind. Its model subtotal MUST provide input, reasoning, provider completion, visible output when determinable, and total token information. Reasoning coverage is calculated over contributing model events only: when every model event reports reasoning, visible output excludes it so displayed components do not double-count; with partial or unavailable model coverage, the API/UI MUST mark that condition and omit the derived visible-output total rather than fabricate it.
- **FR-007**: Each embedding-usage display, including a message summary's embedding subtotal, MUST provide input tokens and vector count plus its provider, model, usage quality, and status where applicable. Its durable event kind, rather than vector count or operation text, MUST identify it as an embedding. Output and reasoning must be unavailable rather than fabricated for embeddings.
- **FR-008**: Each detailed record or message summary MUST expose safe attribution and diagnostic metadata: occurrence time, workspace, provider, model or models, operation label or labels, status/attempt count, and actual-versus-estimated usage quality.
- **FR-009**: The system MUST persist separately reported reasoning tokens for new model usage events. It MUST retain the distinction between an unavailable reasoning count and a known zero, and MUST not infer this field for historical records.
- **FR-010**: The system MUST persist a non-null durable `model`, `embedding`, or `unknown` event kind for every usage event. All new writes set model or embedding through the recorder's typed paths. The migration classifies only historical rows with durable evidence (the recorder's model/embedding idempotency prefix, embedding-item lineage, or a positive vector count); it assigns `unknown` where the existing immutable row cannot be classified honestly, without changing any token values.
- **FR-011**: Directive-coherence model calls MUST carry their actual account-owned workspace and agent attribution into the model-inference pipeline so their usage events can be recorded and reported as internal operations.
- **FR-012**: Detailed-usage APIs MUST require active membership in the current account, validate optional workspace filters against that account, bound the requested time range and page size, and use stable cursor pagination.
- **FR-013**: Detailed-usage responses and UI MUST use an explicit field allowlist and never contain raw prompts, completions, message text, document/chunk text, secrets, credentials, cookies, provider request payloads, connection strings, idempotency keys, provider request IDs, or error-code/detail values.
- **FR-014**: The dashboard MUST present loading, empty, and recoverable error states for both detailed views and preserve the selected filters when a page is refreshed.
- **FR-015**: The API contract, OpenAPI artifacts, account/API documentation, and usage-event taxonomy documentation MUST describe the detailed views, authorization, privacy boundary, reasoning-token coverage, event-kind semantics, and status/quality semantics.
- **FR-016**: This feature MUST NOT add durable job/batch grouping, modify document-worker dispatch/AMQP payloads, change usage-limit enforcement, or add pricing/cost calculations.

### UI Tasks

- Add an AI usage tab within Usage, alongside the existing overview content.
- Add a Messages view with date/workspace filters, a paginated message table, token breakdown columns, provider/model and operation context, and an empty state.
- Add an Internal operations view with the same filter model, paginated model/embedding records, metadata-generation labeling, status/quality indicators, vector counts where relevant, and an empty state.
- Make unavailable token dimensions visually distinct from known zero values and use existing accessible table, tab, badge, and loading patterns.

### Key Entities

- **Usage Event**: The immutable existing ledger record for one model or embedding provider attempt. It carries account/workspace lineage, safe operation metadata, resource counts, status, quality, and occurrence time.
- **Usage Event Kind**: The durable `model`, `embedding`, or `unknown` classification. New rows are assigned model or embedding by the typed ledger writer; unknown is reserved for ambiguous historical rows. It is independent of user-facing labels.
- **Message Usage Summary**: A derived, account-scoped view that aggregates usage events associated with one end-user message. It has separate model, embedding, and unknown-historical subtotals, so query embeddings do not distort model reasoning coverage. It is not a new persisted entity.
- **Internal Usage Event**: A derived, account-scoped detailed ledger view for all events that are not end-user-message usage, including operator and background work. It is not a new persisted entity.
- **Reasoning Token Count**: A nullable provider-reported model-usage dimension. Its availability state is preserved so historical or unsupported providers are not represented as zero.
- **Reasoning Coverage**: The derived `complete`, `partial`, or `unavailable` state for the model subset of a message aggregate. Only complete model coverage permits a visible-output total derived by subtracting reasoning from provider completion counts.

## API and Access Direction

The feature adds session-authenticated account reporting resources for paginated message summaries and internal usage events. Both accept a bounded inclusive UTC date range, an optional account-owned workspace filter, and a cursor/page limit. Their response shapes intentionally differ: message rows are aggregations while internal rows are individual ledger attempts. Message cursors keyset-paginate by most-recent activity plus message ID after aggregation; internal cursors use occurrence time plus event ID.

Active account membership is the authorization bar, matching the existing Usage trends report. This is a dashboard/session API, so it is documented through OpenAPI and is not added to the API-key TypeScript SDK.

## Message-Queue Impact Review

No message-queue impact is planned. The feature reads the existing durable ledger and extends ledger persistence for a provider-reported token field. It does not change document-worker dispatch, AMQP payloads, retry semantics, queue contracts, or queue documentation. Durable job/batch attribution is explicitly out of scope.

## Observability Review

No new telemetry, metric, audit-event, or span family is required for the read-only reporting endpoints. Existing HTTP error handling covers query failures, and the usage ledger remains the diagnostic source of truth. Reasoning-token persistence extends an existing usage-recording path and must retain its current best-effort, non-blocking behavior; no raw model inputs or outputs may enter logs.

## Documentation Impact

- Update `docs-portal/content/api/accounts-and-users.mdx` with the session-authenticated detailed-usage resources and privacy/access semantics.
- Update `docs/architecture/usage-event-taxonomy.md` with reasoning-token and message/internal-classification semantics.
- Update `readme.md` to mention detailed AI usage alongside existing Usage trends.

## Assumptions

- Existing active account members may view operational usage, consistent with Usage trends.
- The default selected range is recent and bounded; exact range/page-limit values are set during planning based on query-plan validation.
- Provider-reported `output_tokens` may include reasoning tokens. The read model, not provider adapters, derives the non-reasoning output displayed beside a separate reasoning count.
- Existing ledger rows remain immutable. Adding reasoning-token persistence affects new events only; historical rows show the field as unavailable. Historical rows receive only the durable event-kind classification needed to filter/report them, and ambiguous rows remain unknown rather than guessed.
- Metadata generation is the user-facing label for the existing document-enrichment operation.
- The known labels are backed by structured surface/operation values: Agent setup (`agent_wizard` / `analyze_website`), Draft directive (`agents` / `draft_directive`), Directive coherence (`agents` / `directive_coherence`), and Metadata generation (`documents` / `document_enrichment`). Unknown values retain a safe generic humanized label.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For seeded turns containing one to five model calls, the Messages view presents exactly one row per end-user message and its model token components reconcile with the recorded model total without double counting known reasoning usage. Mixed model reasoning coverage is visibly partial and does not produce a derived visible-output total.
- **SC-001a**: A seeded query embedding linked to that message appears in its separate embedding subtotal and does not change the model reasoning-coverage state or visible-output calculation.
- **SC-002**: For seeded metadata generation, embedding (including a zero-vector failure), agent-setup, directive-draft, directive-coherence, operator-test, and eval events, Internal operations presents each attempt in the correct category with its recorded status and quality.
- **SC-003**: A member can narrow either detailed view to a selected account workspace and receive a stable, paginated result set; an invalid cross-account workspace is rejected with no data leakage.
- **SC-004**: Automated contract, integration, and browser tests demonstrate that no detailed-usage response or rendered view contains message, prompt, completion, document, chunk, credential, cookie, or connection-string content.
- **SC-005**: New provider-reported reasoning usage is visible when available, while historical and unsupported-provider records display it as unavailable rather than zero. A directive-coherence attempt persists under its real workspace and appears as an internal operation.
