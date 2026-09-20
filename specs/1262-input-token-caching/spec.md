# Feature Specification: Provider-Neutral Input Token Caching

**Feature Branch**: `1262-input-token-caching`
**Created**: 2026-09-19
**Status**: Reviewed — ready for planning
**Input**: User description: "Investigate generic input token caching, then deliver a reviewed specification, plan, and implementation that decreases latency where providers support it."

## Purpose and Delivery Scope

Radioso repeatedly sends lengthy model input while answering grounded questions and executing agent turns. This feature makes those repeated leading inputs eligible for a model provider's input-token cache, without coupling product logic to a provider or changing an answer's meaning. It also makes cache usage and latency observable enough to determine whether the feature improves the time a person waits for an answer.

The first delivery is limited to reusable input boundaries for stable instructions and tool catalogs in the grounded-answer and agent-runtime paths; provider capabilities and request mapping for one explicit checkpoint provider and one implicit-cache provider; safe cache and latency telemetry; and a repeatable evaluation procedure. It deliberately does not claim a fixed latency reduction or require an external provider cache hit in deterministic tests.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reuse Stable Model Input (Priority: P1)

As a Radioso operator, I want repeated grounded answers and agent turns to make stable leading input reusable by compatible model providers, so repeated work can begin producing useful answer text sooner without changing the assistant's behavior.

**Why this priority**: Stable instructions and tool definitions are frequently repeated and are the first safe cache candidate. They can reduce provider prompt-processing work while preserving current grounding and agent semantics.

**Independent Test**: A focused backend test can render two equivalent requests for a supported provider and verify that the provider request receives the same reusable boundary while dynamic turn content remains outside it; it can also verify that the resulting prompt roles, order, and content are unchanged.

**Acceptance Scenarios**:

1. **Given** two agent turns use the same instructions and tool catalog but different current messages, **When** a provider that supports reusable input is selected, **Then** the stable leading input is identified consistently and the current message remains dynamic.
2. **Given** a grounded answer has stable instructions followed by current retrieval and user-request content, **When** a provider request is prepared, **Then** only the stable leading portion is eligible for reuse and the answer receives the same semantic input as before caching support.
3. **Given** a provider does not support input token caching, **When** it serves either flow, **Then** it receives an ordinary request and the user-visible result follows existing behavior.

---

### User Story 2 - Understand Cache Effect and Latency (Priority: P1)

As an operator or support engineer, I want safe cache-use and duration information for each model call, so I can distinguish a cache miss, unavailable provider accounting, and slow model behavior without collecting sensitive prompt content.

**Why this priority**: Cache configuration alone does not establish value. Operators need reliable evidence before expanding caching mechanisms or assuming a latency improvement.

**Independent Test**: Provider result normalization tests can supply cache read, cache write, and absent provider accounting and verify the safe metrics and diagnostic fields distinguish each state without containing raw prompts, completions, document text, credentials, or cache handles.

**Acceptance Scenarios**:

1. **Given** a provider reports cached input usage, **When** a model call completes, **Then** the normalized model-call record identifies cached reads and writes separately from other input usage.
2. **Given** a provider omits cache accounting, **When** a model call completes, **Then** cache reads and writes are each recorded as unknown rather than reported as zero or inferred as a miss.
3. **Given** a model call is streamed, **When** the current architecture cannot provide a reliable model time-to-first-token boundary, **Then** the system records only the available, precisely defined duration boundaries and does not invent a time-to-first-token value.

---

### User Story 3 - Evaluate Before Expanding (Priority: P2)

As a Radioso maintainer, I want a repeatable cold, warm, expiry, configuration-change, and concurrent-request evaluation procedure, so we can decide from measurements whether provider token caching improves latency enough to justify further lifecycle work.

**Why this priority**: Provider cache retention, minimum sizes, load, and routing determine practical benefit. A deterministic test proves integration behavior, while a controlled live evaluation establishes operational benefit.

**Independent Test**: A documented procedure or harness can exercise every required condition with equivalent inputs, record cache-use and available duration data, and separate deterministic assertions from provider-gated measurements.

**Acceptance Scenarios**:

1. **Given** a compatible provider and equivalent repeated input, **When** the evaluation runs a cold request followed by a warm request, **Then** it records cache-use accounting when available and comparable latency boundaries for both requests.
2. **Given** a cache entry's expiry is observable or the stable agent configuration changes, **When** the same evaluation is run, **Then** it records the observed cache accounting or an expiry-not-observed/unknown state without treating it as an application failure.
3. **Given** concurrent equivalent requests, **When** the evaluation runs, **Then** it records latency and cache-use outcomes per request without promising cache locality or a fixed improvement.

### Edge Cases

- A provider requires a reusable prefix to meet a minimum size, or rejects an explicit checkpoint because the candidate is too small.
- An explicit cache option is rejected before generation, or a cache expires, is evicted, or provider service becomes unavailable after dispatch.
- A provider reports only total input tokens, reports cache reads or writes in a provider-specific field, or omits cache accounting entirely.
- Stable agent configuration, tools, prompt policy, model, or provider selection changes between requests.
- Retrieval returns different documents, a conversation is summarized or pruned, or a current-turn tool result changes; none of that dynamic content may be frozen or moved into a reusable prefix merely to increase hits.
- The same configured model is used by two workspaces or credential scopes; cache references and telemetry must not cross workspace, credential, model, or content-revision boundaries.
- Streaming calls produce response chunks before final provider usage, fail, retry, or terminate early.
- Repeated or concurrent requests have reported zero reads, unknown accounting, or a provider cache miss despite identical application input; only an explicit provider miss is called a miss.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Prompt composers and the agent runtime own the semantic division between reusable leading input and dynamic input. The shared inference contract carries a narrow, ordered, role-preserving representation of the exact stable system prefix and the following dynamic suffix, with one explicit breakpoint at the end of a contiguous leading prefix. Provider adapters own provider capability checks, native checkpoint fields, deterministic rendering of that prefix, implicit-cache-compatible request rendering, provider cache-accounting extraction, and fallback behavior. Application composition evaluates any app-wide wiring; it must not contain prompt semantics. Domain modules must not import provider-specific cache controls.
- **Prompt Integrity Rule**: The reusable boundary must preserve current message roles, ordering, instruction precedence, tool-catalog order as supplied, and input content. It ends before the first volatile content; a stable section following volatile steering is not eligible in this pilot. The system must not reorder, summarize, freeze, or promote current user messages, retrieved documents/chunks, tool results, or other untrusted dynamic material solely to improve cache eligibility.
- **Pilot Rule**: The initial reusable material is stable instructions and tool catalogs. Append-only conversation history may be evaluated during planning but is not part of the first implementation unless its semantics and invalidation behavior are independently specified and reviewed.
- **Capability Rule**: The provider-neutral capability model must resolve against the selected provider family, model, and endpoint/API-mode configuration, with unsupported as the safe default. It must represent unsupported behavior, implicit reuse, and explicit checkpoint support, plus only pilot-relevant safe eligibility constraints, without becoming a global provider-policy registry or making a cache hit a product guarantee. The first implementation must exercise one explicit-checkpoint and one implicit-cache path, including supported and unsupported configurations of the same provider family where applicable. Unsupported configurations use an ordinary request without error.
- **Lifecycle Rule**: This feature must not introduce explicit cache-object creation, cache-handle persistence, prewarming, response caching, semantic caching, self-hosted cache-aware routing, or deployment routing changes. If future work introduces explicit cache objects, their provider-owned state and Radioso metadata must be scoped by workspace, credentials, provider, model, and content revision.
- **Observability Rule**: The existing low-cardinality metrics registry and safe transient diagnostics are the pilot's telemetry destination for normalized cache read, cache write, unknown accounting, and available duration boundaries; this pilot adds no database/schema migration or durable usage-event/model-call-record fields. Allowed metric labels are bounded operation/surface, provider family, bounded model group, resolved cache capability, accounting state, outcome, and named timing boundary. Labels must never contain workspace, conversation, request, credential, revision/fingerprint, cache-handle, raw model, error text, or other unrestricted values. Observability must not record raw prompts, completions, retrieved chunks, document content, tokens, credentials, cookies, connection strings, cache handles, or provider secrets. Cache telemetry is operational metadata, not a replacement for logs, metrics, traces, audit events, or usage accounting.
- **Latency Rule**: `provider_invocation_duration` runs from adapter invocation start through completion/error of the provider call for non-streaming calls, inclusive of adapter serialization, transport, provider work, and buffering. `adapter_first_text_duration` runs from the same start through the first text yielded by the adapter, inclusive of those same delays, and is recorded only when text is yielded. Neither is model TTFT or user-visible latency.
- **Durability Rule**: A provider's normalized accounting may be absent, late, or incomplete. Metrics and diagnostics must distinguish unknown from zero and must not block, fail, or alter an otherwise valid answer solely because cache accounting or telemetry recording is unavailable.
- **Contract and Composition Rule**: Planning must evaluate `backend/src/app/composition/` for any app-wide provider capability registry, cache-metadata recorder, or lifecycle wiring. It must assess whether shared inference contract changes affect public APIs, SDKs, MCP, connectors, worker payloads, AMQP dispatch, retry semantics, queue documentation, or contract tests; those surfaces remain unchanged unless the plan documents a required change and its impact.
- **Copilot Coverage Rule**: This backend/operator-facing behavior must ship with an operator copilot tool descriptor or a stated coverage-map exclusion in the same implementation change.
- **Test and Documentation Rule**: Backend behavior follows red-green-refactor TDD. The implementation must add focused deterministic tests for final request preservation, deterministic stable-prefix rendering, supported and unsupported provider/model/endpoint mapping, accounting normalization, telemetry recording, redaction, and fallback. It must document the evaluation procedure and any operator-observable behavior that changes.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST represent reusable leading model input at the shared inference boundary as an ordered, role-preserving exact stable system prefix plus dynamic suffix, with a designated contiguous breakpoint, without provider-specific prompt parsing or a broad multimodal runtime rewrite.
- **FR-002**: The system MUST preserve the existing semantic message roles, order, instruction precedence, tool-catalog order as supplied, and complete dynamic content. Adapters MUST render equal stable prefixes deterministically and place native cache control at the designated boundary without reordering request content.
- **FR-003**: The system MUST identify stable instructions and stable tool catalogs as initial reusable candidates in both the grounded-answer and agent-runtime model-call paths only while they occur before the first volatile input; agent eligibility MUST reflect actual tool-catalog changes.
- **FR-004**: The system MUST keep current user messages, current retrieval output, current tool results, and other per-turn dynamic content outside the initial reusable boundary.
- **FR-005**: The system MUST resolve a provider capability model against the selected provider family, model, and endpoint/API-mode configuration, distinguishing unsupported, implicit-reuse, and explicit-checkpoint behavior with unsupported as the default.
- **FR-006**: The system MUST map the reusable-input intent to one provider's explicit checkpoint mechanism and to one provider's implicit-cache-compatible request path, while keeping provider-specific fields inside adapters.
- **FR-007**: The system MUST send an ordinary request, with unchanged user-visible behavior, when the selected provider or model does not support the requested caching mechanism or declines its use.
- **FR-008**: An implicit-cache miss, expiry, eviction, or unavailable cache is an ordinary request and MUST NOT trigger a retry. The system MAY retry without cache options only for a positively classified cache-option validation rejection before generation when the provider error contract establishes no request was accepted and no adapter text was yielded. It MUST NOT retry after text, cancellation, timeout, dispatch-ambiguous transport failure, partial output, or unclassified provider error, and MUST preserve the original error/result contract in those cases.
- **FR-009**: The system MUST normalize provider-reported cache accounting with an explicit accounting state discriminator and independently optional finite non-negative cached-input read and write counts. Reported zero differs from unknown and neither implies a miss unless the provider explicitly reports one; providers without a write field report write accounting as unknown.
- **FR-010**: The system MUST preserve existing non-cache input, output, and total usage accounting semantics while adding cache-specific accounting where available, including a documented normalization for whether a provider includes cached reads in its reported input total.
- **FR-011**: The system MUST expose normalized cache accounting and precisely defined available durations through the existing low-cardinality metrics registry and safe transient diagnostics, using only the allowed bounded labels. Durable usage-event/model-call-record schema changes are explicitly out of scope for this pilot; planning MUST record the no-migration compatibility and cross-package conclusion.
- **FR-012**: The system MUST record `provider_invocation_duration` for non-streaming calls where available and MAY record `adapter_first_text_duration` for streaming calls only when adapter text is yielded. It MUST use the defined inclusive boundaries and MUST NOT call either model TTFT or user-visible latency.
- **FR-013**: The system MUST ensure cache/latency observability omits raw prompt and completion content, document or chunk text, credentials, tokens, cookies, connection strings, cache handles, and provider secrets.
- **FR-014**: The system MUST preserve workspace, credential, provider, model, and stable-content revision scope when carrying any cache-related metadata, and MUST not share cache references across incompatible scopes.
- **FR-015**: The system MUST not add explicit provider cache-object lifecycle management, cache-handle persistence, prewarming, response or semantic caching, self-hosted routing, public cache settings, or default-model changes in this feature.
- **FR-016**: The system MUST provide a repeatable evaluation procedure or harness covering cold, warm, expiry, stable-configuration-change, and concurrent conditions with equivalent workloads and bounded outputs.
- **FR-017**: The evaluation output MUST report cache-use accounting when available, the definition of each duration boundary, and p50/p95 only with at least 20 successful comparable observations per cohort; otherwise it MUST report cohort count and raw/descriptive observations without percentile claims. Cold/warm cohorts MUST use the same resolved configuration, environment/region, stable input, dynamic payload shape, and bounded output settings, and record confounders. Expiry must wait for documented retention when controllable or report expiry-not-observed/unknown. Cached-token share is reported only when compatible read and total-input definitions are both reported.
- **FR-018**: The system MUST make deterministic tests prove final request construction and semantic preservation, deterministic stable-prefix rendering, supported and unsupported capability fallback, preservation of all no-retry error/result conditions, accounting normalization, telemetry recording, and redaction independently of a provider cache hit. A pre-generation cache-option retry is tested only when a documented provider error contract proves that no request was accepted and no adapter text was yielded; otherwise the pilot preserves the original error without retry.
- **FR-019**: The implementation plan MUST evaluate app composition ownership, public/API/SDK/MCP/connector impact, document-worker and AMQP payload/retry impact, and the operator-copilot coverage requirement; it MUST record a no-impact conclusion for each unchanged surface.
- **FR-020**: The system MUST update applicable contributor or operator documentation with supported behavior, safe fallback semantics, telemetry interpretation, and the live evaluation procedure.

### Key Entities

- **Reusable Input Boundary**: The narrow ordered representation of an exact stable system prefix and dynamic suffix, with one contiguous leading breakpoint eligible for provider reuse while retaining roles and order.
- **Provider Cache Capability**: The selected provider family, model, and endpoint/API-mode configuration's supported cache mechanism and pilot constraints: unsupported, implicit reuse, or explicit checkpoint.
- **Cache Accounting**: An explicit availability/state discriminator plus independently optional cached-input reads and writes; unknown and reported zero are distinct, and neither is an inferred miss.
- **Model-Call Timing**: A named duration with explicit start and end boundaries, recorded only when reliably observable.
- **Stable Content Revision**: A safe identity for the stable input configuration used to prevent incompatible reuse; it is not raw prompt content or a provider cache handle.
- **Evaluation Run**: A controlled comparison of equivalent requests under cold, warm, expiry, change, or concurrent conditions, containing safe accounting and latency observations.

## Assumptions

- Compatible model providers determine actual cache availability, eligibility thresholds, retention, and accounting fields; Radioso cannot guarantee a hit or a latency reduction.
- Existing provider adapters and inference contracts can be extended internally without changing public HTTP, SDK, MCP, connector, or worker contracts for the first delivery. Planning must verify this assumption.
- This pilot relies on the existing metrics exporter and safe transient diagnostics; it does not add durable cache-accounting or timing fields or a database/schema migration.
- Provider invocation duration and adapter-first-text duration use the named inclusive boundaries in this specification; model TTFT and user-visible latency are excluded.
- Documentation updates that describe changed observability behavior will follow `docs/document-writer-prompt.md`.
- Implementation begins only after this draft is independently reviewed and the feedback is resolved.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Focused deterministic tests demonstrate that 100% of tested grounded-answer and agent-runtime requests preserve their pre-feature role sequence and content while exposing only the approved contiguous stable leading candidates; equal stable inputs render an identical stable prefix and changes to the supplied tool catalog change eligibility.
- **SC-002**: Focused deterministic tests demonstrate appropriate explicit and implicit intent for supported resolved configurations and ordinary requests for unsupported ones; only a positively known pre-generation cache-option validation rejection retries without cache options, while every specified ambiguous or post-output condition preserves the original error/result contract.
- **SC-003**: In normalization, metrics, and diagnostic tests, 100% of supplied provider responses with cache reads, cache writes, reported zero, and absent accounting retain their distinct values or unknown state; prohibited sensitive values and disallowed high-cardinality labels are absent from telemetry assertions.
- **SC-004**: The documented evaluation can produce comparable cold, warm, expiry, stable-configuration-change, and concurrent observations with a stated duration definition and cache-use state; no criterion requires a live provider cache hit.
- **SC-005**: When a compatible provider, qualifying repeated input, and a live evaluation environment are available, a cohort with at least 20 successful comparable observations reports cached-token share when compatible accounting exists and p50/p95 of each documented duration boundary for cold and warm samples; smaller cohorts report counts and descriptive/raw observations, allowing a maintainer to assess latency without claiming a predetermined improvement.
- **SC-006**: Existing focused chat, retrieval, agent-runtime, provider, usage-accounting, and observability checks continue to pass for providers that do not support caching.
