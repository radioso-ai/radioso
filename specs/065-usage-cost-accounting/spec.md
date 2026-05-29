# Feature Specification: Usage Cost Accounting

**Feature Branch**: `model-call-cost-accounting`  
**Created**: 2026-05-28  
**Status**: Draft  
**Input**: User description: "Different models have very different costs, and some tools may call the model several times. Track the costs incurred by calling different models. Basic usage accounting should be OSS; Enterprise should add governance, budgets, chargeback, and reporting."

**Related Spec**: `specs/063-enterprise-usage-metering/` remains the umbrella Enterprise metering spec. This spec narrows the model/tool usage ledger into a smaller delivery scope and makes the foundational accounting substrate available in OSS.

**Existing Substrate**: This is not a greenfield ledger. OSS already has a shared usage recorder port and no-op implementation (`backend/src/shared/domain/usageEventRecorder.ts`). Enterprise already has durable usage-event, embedding-lineage, and daily-rollup persistence (`ee_usage_events`, `ee_embedding_usage_items`, `ee_usage_daily_rollups`, written by `ee/packages/backend-module/src/usageLimits/usageEventRecorder.ts`). Document embedding usage and eval model usage already record through composition. The implementation plan MUST treat this feature as a migration and refactor from EE-only durable persistence toward an OSS accounting substrate, preserving existing Enterprise behavior during rollout.

**Substrate Caveats** (verified against current code; the plan MUST account for these):

- **`recordModelCall` has only one real caller today: eval.** Assistant answer generation, retrieval answer generation, query rewrite, and rerank record *nothing*; only document embedding calls `recordEmbedding`. The most user-visible operations in User Story 1 are therefore *new instrumentation*, not a migration of existing call sites. This work has its own delivery phase (see Delivery Split) and MUST NOT be assumed to fall out of the ledger move.
- **The recorder types are duplicated, not shared.** `EmbeddingUsageEvent`, `ModelUsageEvent`, and the status/quality unions are copy-pasted verbatim between the OSS port and the EE recorder. The OSS ledger migration MUST collapse this duplication (EE imports the OSS shared types) so later identity/taxonomy changes cannot silently diverge between the two copies.
- **The current port carries a single `idempotencyKey`** and the EE insert uses `ON CONFLICT (idempotency_key) DO NOTHING`. This conflates the three identities required by FR-005 and cannot express "same logical operation, deliberate second chargeable attempt" (FR-013). Extending the shared type is a breaking change to a contract consumed by both OSS and EE.
- **The existing daily rollup cannot satisfy the required summary grouping.** `ee_usage_daily_rollups` is keyed `(account_id, usage_date, operation, provider, model)`, upserted only when an account is resolved and status is `succeeded`. Summaries require grouping by workspace and surface and distinguishing actual vs estimated (FR-023/FR-024). The plan MUST decide whether summaries read events directly or whether the rollup schema gains workspace/surface/quality dimensions.

## Delivery Split

This specification is an umbrella for usage cost accounting. It MUST NOT be planned or delivered as one implementation branch. Follow-on plans MUST split it into independently reviewable phases:

1. **Provider Usage Metadata**: change provider result contracts so migrated non-streaming and streaming surfaces can expose text plus usage metadata; define final streaming usage handling and how a provider charge for a failed/interrupted request is represented; keep non-migrated surfaces estimated.
2. **OSS Ledger Migration**: move durable usage-event persistence and rebuildable rollups into the OSS accounting substrate while preserving existing Enterprise event data and compatibility; collapse the duplicated OSS/EE recorder types into a single shared contract.
3. **Identity, Taxonomy, And Retention**: standardize logical operation identity, provider attempt identity, idempotency identity, surface/operation names, retention policy, and foreign-key behavior; extend the shared recorder contract and EE conflict semantics accordingly.
4. **Recorder Call-Site Instrumentation**: wire `recordModelCall` into the surfaces that currently record nothing — assistant answer generation, retrieval answer generation, query rewrite, rerank, and the inventoried MCP/skill-intake/tool model-call paths — using the taxonomy and identity model from Phase 3. This is where User Story 1 and SC-002 are actually delivered; it depends on Phases 1 and 3 but MUST NOT be folded into either.
5. **Pricing Assumptions And Summaries**: add pricing catalog decisions, event-time cost snapshots, recalculation semantics, and summary APIs or read models.
6. **Operator UI And Documentation**: add usage views, pricing management, permissions, and operator documentation after the underlying accounting and authorization model is stable.

Each phase MUST have its own plan, tests, and acceptance criteria. Later phases may be split further if planning shows they still combine unrelated contracts, persistence, and UI work.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand Model Spend Drivers (Priority: P1)

As a self-hosted Radioso operator, I want to see which assistants, conversations, tools, providers, and models are driving AI usage cost so I can explain cost changes without reading provider invoices or raw logs.

**Why this priority**: A single user message can fan out into multiple model-backed operations. Message counting hides the real cost driver and makes expensive tools or models difficult to diagnose.

**Independent Test**: Can be fully tested by running assistant, retrieval, and tool-backed flows that use different models, then reviewing usage summaries and confirming each model-backed operation is counted separately.

**Acceptance Scenarios**:

1. **Given** one user message triggers answer generation and two model-backed tool calls, **When** usage accounting is reviewed, **Then** three separate usage events are visible and associated with the same originating interaction.
2. **Given** two assistants use different configured models, **When** both answer similar questions, **Then** usage summaries separate cost by provider, model, assistant, and day.
3. **Given** a workspace has no activity in a period, **When** the operator reviews usage, **Then** the summary reports zero usage without requiring provider invoice data.

---

### User Story 2 - Preserve An Explainable Usage Ledger (Priority: P1)

As a Radioso administrator, I want every metered AI operation stored as an immutable event so later cost summaries remain explainable even when model prices or reporting views change.

**Why this priority**: Price catalogs and product reports will evolve. The durable source of truth must be the work performed, not a mutable aggregate or a per-message estimate.

**Independent Test**: Can be fully tested by executing model and embedding operations, changing configured prices, and verifying historical events retain enough information to explain the original and recalculated estimates.

**Acceptance Scenarios**:

1. **Given** a model call completes with provider-reported usage, **When** the event is recorded, **Then** provider, model, operation, surface, token counts, status, usage quality, price reference, and estimated cost are preserved.
2. **Given** a provider omits token usage, **When** the event is recorded, **Then** estimated usage is stored and clearly marked as estimated.
3. **Given** an operation attempt is retried after an uncertain delivery outcome, **When** usage is recorded with the same operation and attempt identity, **Then** the ledger does not double count the same attempt.
4. **Given** the same logical operation deliberately makes a second provider attempt, **When** that second attempt consumes provider resources, **Then** it can be recorded separately while remaining linked to the same operation.

---

### User Story 3 - Configure Cost Assumptions Without Billing Customers (Priority: P2)

As an operator, I want to configure or update model pricing assumptions so Radioso can estimate internal cost without turning usage accounting into customer invoicing.

**Why this priority**: Self-hosted installations may use different providers, local models, contract prices, or free tiers. Cost accounting must be useful even before Enterprise billing or governance exists.

**Independent Test**: Can be fully tested by configuring prices for multiple models, recording usage, and verifying summaries use the configured price assumptions while unpriced usage remains visible.

**Acceptance Scenarios**:

1. **Given** an operator configures input and output token prices for a model, **When** usage is recorded for that model, **Then** the event and summary include an estimated cost derived from that pricing assumption.
2. **Given** a model has no configured price, **When** usage is recorded, **Then** the event is still stored and appears as unpriced rather than being dropped.
3. **Given** a price changes, **When** historical usage is reviewed, **Then** the operator can distinguish the estimate captured at event time from any recalculated estimate using current prices.

---

### User Story 4 - Provide An Enterprise Extension Point (Priority: P3)

As an Enterprise operator, I want governance features to build on the same usage ledger so budgets, quotas, chargeback, and billing exports do not create a second accounting path.

**Why this priority**: Enterprise financial controls need the same factual usage substrate as OSS diagnostics. Duplicating metering would create reconciliation problems.

**Independent Test**: Can be fully tested by enabling an Enterprise module that reads the OSS usage ledger and derives policy decisions or reports without changing how usage events are captured.

**Acceptance Scenarios**:

1. **Given** OSS usage accounting is enabled, **When** an Enterprise reporting or budget module is added, **Then** it consumes the same recorded usage events instead of introducing a parallel ledger.
2. **Given** an Enterprise policy blocks a future expensive operation, **When** reports are reviewed, **Then** previously recorded usage remains immutable and separate from the policy decision.

### Edge Cases

- What happens when provider usage arrives after a streamed response has already begun?
- What happens when provider usage is only available in a final streaming event rather than in streamed text chunks? (Resolve in Phase 1; it is a provider result-contract decision, not a summary-time concern.)
- What happens when a streamed response is interrupted after partial output was generated?
- What happens when a provider charges for a failed or rate-limited request? (Resolve in Phase 1 alongside status and usage-quality semantics, since cost-on-failure changes what the contract must surface.)
- What happens when the active pricing catalog does not include the provider or model used by an operation?
- What happens when a tool performs nested or repeated model calls for one user-visible action?
- What happens when a local or free model has usage but no monetary provider cost?
- What happens when an event is recorded but summary aggregation fails?
- What happens when historical events were recorded before pricing assumptions existed?
- What happens when usage events reference conversations, messages, documents, or jobs that are later deleted or redacted?
- What happens when existing EE usage-event rows need to become readable through the OSS accounting surface without losing historical reports?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and TypeScript.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, persistence, provider adapters, and Enterprise policy modules.
- Runtime LLM prompt templates, if any are introduced by follow-on work, MUST live under `backend/prompts/`.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings.
- Public contract changes MUST update the code-first OpenAPI registry, generated OpenAPI artifacts, SDK types, and relevant docs.
- Contract changes MUST include message-queue impact review for document worker payloads, retry semantics, AMQP queue behavior, and queue docs/tests.
- Documentation that explains setup, APIs, assistant usage, retrieval, SDK usage, MCP usage, or operator settings MUST be updated in the same change when affected.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Model and embedding providers own provider-specific usage extraction. Chat, retrieval, eval, document processing, and tool orchestration own operation context and lineage. A shared usage accounting surface owns normalized event capture and cost estimation. Enterprise modules own budgets, quotas, chargeback, exports, and invoice-oriented behavior.
- **Encapsulation Rule**: Route handlers, chat services, retrieval services, document workers, and tool implementations MUST NOT contain provider price math or write reporting aggregates directly. They may pass operation context to a narrow usage recorder.
- **Migration Rule**: Planning MUST start from the existing OSS usage recorder port, existing Enterprise durable ledger tables, current document embedding usage recording, and current eval model usage recording. New work MUST generalize, migrate, or wrap these seams instead of creating a parallel ledger. The duplicated recorder type definitions across the OSS port and the EE recorder MUST be collapsed into a single shared contract during migration so identity and taxonomy changes apply in one place.
- **Provider Result Rule**: Actual token accounting requires provider result contracts that carry generated text plus usage metadata. Non-streaming calls need a result object rather than text alone. Streaming calls need a final usage/metadata path. Until a provider can expose actual usage through that contract, its usage MUST remain estimated.
- **Source Of Truth Rule**: Immutable usage events are the source of truth for model and embedding work. Summaries, dashboards, and daily aggregates are derived caches and MUST be rebuildable.
- **Rollup Recovery Rule**: Ledger insertion MUST be authoritative. Rollup and summary updates MUST be rebuildable and recoverable, and a rollup failure MUST NOT require discarding an otherwise valid ledger event.
- **Identity Rule**: Usage accounting MUST distinguish logical operation identity from provider attempt identity. Duplicate delivery of the same attempt must be idempotent; separate provider attempts under the same operation may be counted separately when they consume resources. The current shared port carries only a single `idempotencyKey` and the EE insert deduplicates on it alone; the plan MUST extend the shared contract to carry the three distinct identities and revise the EE conflict target so a deliberate second chargeable attempt is not silently dropped.
- **Operation Taxonomy Rule**: The plan MUST define a controlled surface and operation taxonomy before adding new recorder call sites. At minimum it must cover current document embedding, eval full-assistant replay, eval LLM judge, assistant answer generation, retrieval answer generation, query rewrite, rerank, and any MCP/tool or skill-intake path that performs a model call.
- **Pricing Money Rule**: The plan MUST choose a concrete money representation before implementation, including currency code, integer minor units versus micros or decimal storage, rounding rules, overlapping effective-period behavior, and uniqueness constraints for provider/model/unit/effective-period records.
- **Access Control Rule**: Usage summaries and pricing assumptions expose sensitive operational and cost information. The plan MUST define explicit account/workspace permissions for viewing usage and managing pricing, rather than reusing unrelated settings or model-management permissions by accident.
- **OSS/Enterprise Rule**: OSS MUST include enough usage accounting for operators to diagnose cost and model usage. Enterprise MAY extend this with policy and finance workflows, but Enterprise MUST NOT be required to record basic usage events.
- **Privacy Rule**: Usage events MUST NOT store raw prompts, raw assistant responses, raw tool arguments, raw document or chunk text, secrets, session material, connector credentials, or provider API keys.
- **Retention Rule**: The plan MUST decide usage-event retention and foreign-key behavior before implementation. The ledger must remain explainable after optional child resources are deleted or redacted, while account/workspace deletion and customer-data retention obligations must remain enforceable.
- **New Seams Required**: Introduce or extend a focused usage-event recorder, a pricing assumption catalog, and usage summary read models. Enterprise governance must consume these surfaces rather than duplicating metering.
- **Anti-Goals**: Do not account by user message alone. Do not treat estimated internal cost as a customer invoice. Do not make model pricing a hard-coded provider adapter concern. Do not make daily rollups the only source of usage truth. Do not block core chat or ingestion flows solely because usage summary aggregation is unavailable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST extend the existing OSS usage recorder port and existing Enterprise usage-event persistence instead of creating an unrelated metering mechanism.
- **FR-002**: The system MUST provide a migration or compatibility path so existing Enterprise usage-event, embedding-lineage, and daily-rollup data remains usable after durable usage accounting moves into the OSS substrate.
- **FR-003**: The system MUST record one usage event for each billable or cost-relevant provider attempt, including assistant answers, retrieval answers, query rewrites, reranking, tool model calls, eval model calls, and embedding operations when those operations are performed by Radioso.
- **FR-004**: The system MUST allow multiple usage events to be associated with a single logical operation, user-visible interaction, conversation turn, message, job, or tool execution.
- **FR-005**: Usage events MUST include provider, model, operation type, product surface, workspace, account when available, status, usage quality, occurrence time, logical operation identity, provider attempt identity, and idempotency identity.
- **FR-006**: Usage events MUST include input tokens, output tokens, total tokens, byte counts, vector counts, or other provider-relevant units when applicable and available.
- **FR-007**: Usage events SHOULD include conversation, message, assistant, document, document revision, source, job, tool, provider request ID, and error code when available.
- **FR-008**: Provider result contracts MUST expose generated text plus usage metadata for non-streaming calls before those calls can be marked as actual usage.
- **FR-009**: Streaming provider result contracts MUST expose final usage metadata separately from text chunks before streamed calls can be marked as actual usage.
- **FR-010**: Provider-reported usage MUST be stored as actual usage only when it is available through the provider result contract.
- **FR-011**: Estimated usage MUST be stored when provider-reported usage is unavailable, and the event MUST identify the estimate as non-authoritative.
- **FR-012**: Duplicate delivery or retry of the same provider attempt MUST be idempotent and MUST NOT increase aggregate usage or cost.
- **FR-013**: Separate provider attempts for the same logical operation MAY be recorded as distinct events when each attempt may have consumed provider resources.
- **FR-014**: Failed, interrupted, or canceled model-backed operations MUST be recordable when they may have consumed provider resources or are useful for reliability analysis.
- **FR-015**: A successfully recorded ledger event MUST remain authoritative even if rollup or summary aggregation fails.
- **FR-016**: Rollups and summaries MUST be rebuildable from immutable ledger events.
- **FR-017**: Usage event recording failures MUST NOT erase successful product work; failures MUST be observable so operators know accounting may be incomplete.
- **FR-018**: The system MUST define retention and foreign-key behavior for usage events that reference accounts, workspaces, conversations, messages, documents, jobs, tools, and eval runs.
- **FR-019**: The system MUST support a pricing assumption catalog keyed by provider, model, unit type, currency, and effective period.
- **FR-020**: Pricing assumptions MUST support distinct input-token, output-token, cached-input-token, reasoning-token, embedding-token, vector, image, audio-duration, request, or provider-specific unit prices as applicable.
- **FR-021**: Usage events MUST preserve the pricing reference or snapshot used for the event-time estimated cost when a matching pricing assumption exists.
- **FR-022**: Usage events without a matching pricing assumption MUST remain visible as unpriced usage and MUST NOT be excluded from usage counts.
- **FR-023**: Usage summaries MUST support grouping by date range, account, workspace, assistant, surface, operation, provider, model, status, and usage quality. The existing daily rollup is keyed by account/date/operation/provider/model only; the plan MUST either query immutable events directly for these groupings or extend the rollup dimensions, and MUST state which.
- **FR-024**: Usage summaries MUST distinguish actual provider usage from estimated usage.
- **FR-025**: Usage summaries MUST distinguish event-time estimated cost from any recalculated estimate based on current pricing assumptions.
- **FR-026**: Operators MUST be able to inspect enough lineage for an event to identify the originating surface or workflow without exposing raw prompt, document, response, credential, or secret content.
- **FR-027**: OSS installations MUST have basic usage accounting and summaries available without installing Enterprise packages.
- **FR-028**: Enterprise governance features such as budgets, spend limits, quota enforcement, chargeback, anomaly detection, finance exports, and invoice generation are out of scope for this OSS feature but MUST be able to consume the same usage ledger in follow-on work.
- **FR-029**: Existing Enterprise usage-limit behavior MUST remain compatible with this feature and MUST NOT require a second model-usage ledger.
- **FR-030**: Public operator documentation MUST explain that usage accounting is internal cost observability, not customer billing or invoicing.
- **FR-031**: Public operator documentation MUST explain how one user message can produce multiple usage events.
- **FR-032**: Public operator documentation MUST explain how unpriced models, local models, estimated usage, and pricing changes are represented.
- **FR-033**: Any public API or SDK changes for usage summaries MUST be additive during rollout.
- **FR-034**: Message-queue review MUST confirm whether document worker dispatch, model-backed background jobs, retries, and queue payloads carry enough stable logical operation and provider attempt identity for idempotent usage events.
- **FR-035**: The implementation plan MUST split this umbrella scope into phased deliveries and MUST NOT combine provider contract migration, ledger migration, identity/taxonomy work, recorder call-site instrumentation, pricing, summaries, UI, and documentation into a single delivery branch.
- **FR-035a**: The plan MUST treat instrumentation of the assistant answer, retrieval answer, query rewrite, rerank, and tool/MCP/skill-intake model-call sites as explicit deliverables. These call sites do not record model usage today and MUST NOT be assumed to be covered by the ledger migration or the taxonomy mapping alone.
- **FR-036**: The plan MUST define a controlled operation taxonomy for usage events and MUST map all existing model-backed surfaces to that taxonomy before adding new event strings.
- **FR-037**: Tool-related usage accounting MUST name the specific current MCP, skill-intake, or tool execution paths that can perform model calls; generic "tool model call" support is not complete until those paths are inventoried and mapped.
- **FR-038**: The plan MUST define explicit permissions for account-level usage viewing, workspace-level usage viewing, and pricing-assumption management.
- **FR-039**: Usage and pricing APIs or UI MUST enforce the defined permissions and MUST not expose account-wide cost data to principals that only have narrower workspace access.
- **FR-040**: The pricing catalog plan MUST define money storage, rounding, effective-period overlap handling, and uniqueness constraints before implementation.
- **FR-041**: Pricing assumptions MUST be auditable enough for an operator to know which user or system process changed a price and when, if editable pricing is included in a delivery phase.

### UI Tasks

- Operators can open a usage accounting view for the current workspace or account.
- Operators can filter usage by date range, provider, model, assistant, operation, and product surface.
- Operators can see total usage units, estimated cost, unpriced usage, and estimated-versus-actual quality indicators.
- Operators can drill into a usage event enough to identify its originating conversation, message, document job, eval run, or tool execution when that lineage is available.
- Operators can manage pricing assumptions or see clear guidance when a model is unpriced.

### Key Entities *(include if feature involves data)*

- **Usage Event**: An immutable record of a model-backed or embedding operation that consumed or may have consumed provider resources.
- **Usage Lineage**: References from a usage event to the originating account, workspace, assistant, conversation, message, document, job, tool, eval run, or request context.
- **Logical Operation Identity**: A stable identity for the user-visible or system-visible operation being performed, such as an assistant turn, document processing job, eval run, or tool execution.
- **Provider Attempt Identity**: A stable identity for a specific provider attempt under a logical operation, used to distinguish duplicate delivery from a genuinely separate chargeable attempt.
- **Usage Unit**: A measured resource quantity such as input tokens, output tokens, cached input tokens, reasoning tokens, embedding tokens, vectors, images, audio seconds, bytes, or requests.
- **Usage Quality**: Whether usage quantities are provider-reported actual values or system-estimated values.
- **Pricing Assumption**: An operator-configured or bundled price entry for a provider, model, unit, currency, and effective period.
- **Event-Time Cost Estimate**: The estimated cost attached to a usage event using the pricing assumption known when the event was recorded.
- **Recalculated Cost Estimate**: A derived estimate created later from current or selected pricing assumptions.
- **Usage Summary**: A derived report that aggregates usage events by time, provider, model, surface, operation, account, workspace, or assistant.

## Assumptions

- Cost accounting is useful to all self-hosted operators, so the base ledger and summaries belong in OSS.
- Enterprise financial controls will be layered on top of the OSS ledger rather than implemented as a separate accounting system.
- Existing Enterprise usage-event data should be preserved or made query-compatible rather than discarded.
- Pricing data may be operator-provided, bundled, or absent; absence of pricing must not prevent usage metering.
- Event-time estimates are for internal accounting and diagnostics, not legal invoices.
- Historical backfill of model usage before this feature ships is not required unless a follow-on migration can derive trustworthy events.
- Usage events may retain stable IDs for deleted or redacted resources, but must not retain raw customer content.
- Actual provider usage is only achievable after the relevant provider contract exposes usage metadata; until then, affected flows remain estimated.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For tested assistant, retrieval, eval, tool, and embedding flows, each model-backed operation produces exactly one idempotent usage event per actual attempt that should be accounted.
- **SC-002**: A test flow where one user message triggers at least three model-backed operations reports those operations as separate events linked to the same originating interaction.
- **SC-003**: Usage summaries can group usage by provider, model, operation, and day for a selected workspace or account.
- **SC-004**: For provider surfaces migrated to usage-metadata result contracts, at least 95% of successful calls store provider-reported token usage when the provider supplies it; non-migrated or metadata-unavailable calls are marked estimated.
- **SC-005**: Replaying the same idempotent usage event does not increase aggregate usage or estimated cost.
- **SC-006**: Unpriced model usage appears in summaries within the same reporting period and is clearly separated from priced estimated cost.
- **SC-007**: Changing a pricing assumption does not mutate the original event-time cost estimate for existing events.
- **SC-008**: Enterprise modules can consume the OSS usage ledger for future budgets or reports without changing how OSS events are recorded.
