# Feature Specification: Provider-Agnostic LLM Registry

**Feature Branch**: `023-provider-registry`  
**Created**: 2026-03-21  
**Status**: Draft  
**Input**: User description: "Make LLM integrations provider-agnostic across OpenAI, Gemini, Claude, and OpenAI-compatible backends while preserving GPT-5.2 as the default provider"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Switch Providers by Configuration (Priority: P1)

As an operator or backend engineer, I can configure which model provider powers chat and retrieval-related model calls without rewriting application services, so that the product can move between OpenAI, Gemini, Claude, and OpenAI-compatible backends with lower delivery risk.

**Why this priority**: This is the primary business outcome. If provider changes still require service rewrites, the feature fails its purpose.

**Independent Test**: Can be fully tested by configuring the system for the default provider and at least one alternate provider, then verifying that the same chat and retrieval entrypoints continue to work without application-layer code changes.

**Acceptance Scenarios**:

1. **Given** the system is configured for the default provider, **When** a chat request and retrieval-backed answer run, **Then** the system completes successfully using the configured provider without changing route or service behavior.
2. **Given** the system is reconfigured to use an alternate supported provider, **When** the same chat and retrieval-backed answer run, **Then** the system routes model-backed operations through the alternate provider without requiring rewrites in chat or retrieval orchestration modules.

---

### User Story 2 - Add New Providers Behind Stable Seams (Priority: P2)

As a backend engineer, I can add or maintain provider adapters behind explicit capability boundaries, so that new vendors or OpenAI-compatible backends do not force provider logic into orchestration files.

**Why this priority**: The architecture improvement only matters if new provider work has a clear ownership model and does not spread across the codebase.

**Independent Test**: Can be fully tested by reviewing the composition root and capability adapters, and by proving that provider-specific logic is isolated from route handlers, chat orchestration, and retrieval orchestration.

**Acceptance Scenarios**:

1. **Given** an engineer needs to add or update a provider adapter, **When** they inspect the backend module structure, **Then** the owning interfaces, adapter modules, and configuration entrypoints are obvious.
2. **Given** a provider-specific SDK changes, **When** the engineer updates that integration, **Then** the change is limited to provider adapter and composition modules rather than unrelated domain or transport files.

---

### User Story 3 - Fail Safely When Provider Configuration Is Invalid or Unavailable (Priority: P3)

As an operator, I can understand when provider configuration is invalid or a provider is unavailable, so that the system fails predictably and preserves customer trust.

**Why this priority**: Multi-provider support increases configuration and dependency risk. Failure behavior must stay controlled because the product handles customer data and production chat flows.

**Independent Test**: Can be fully tested by supplying unsupported provider settings or simulating provider unavailability and verifying that the system produces clear, bounded failures without leaking secrets or corrupting chat behavior.

**Acceptance Scenarios**:

1. **Given** provider configuration names an unsupported provider or omits required settings, **When** the backend starts or resolves dependencies, **Then** the failure clearly identifies the invalid configuration without exposing secrets.
2. **Given** a supported provider is temporarily unavailable, **When** a model-backed operation runs, **Then** the system returns the same class of safe failure behavior currently expected by chat and retrieval callers.

### Edge Cases

- Different providers expose different streaming payload shapes, but chat streaming must preserve the existing event contract for callers.
- One provider supports embeddings while another provider path is configured only for text generation, and the system must reject incompatible capability mappings clearly.
- A provider returns malformed structured output for rewrite or rerank flows, and the existing fallback behavior must remain intact.
- OpenAI-compatible backends may share a protocol shape with OpenAI but differ in model names or response quality, and configuration must treat them as a distinct operator choice.
- Required credentials for one provider are missing while credentials for another provider are present, and startup or dependency resolution must fail only for the configured provider path.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP routes and application services remain callers of chat and retrieval capabilities only; provider selection and SDK wiring belong in shared infrastructure and backend dependency composition; provider adapters own vendor request and response translation; persistence modules remain unchanged unless a spec-approved data need emerges.
- **Encapsulation Rule**: [`backend/src/app/server/dependencies.ts`](/Users/dm/conductor/workspaces/hivec/vendor-agnostic-llm/backend/src/app/server/dependencies.ts) MUST remain a composition root and MUST NOT absorb provider-specific branching beyond selecting adapters from configuration. [`backend/src/modules/chat/services/chatService.ts`](/Users/dm/conductor/workspaces/hivec/vendor-agnostic-llm/backend/src/modules/chat/services/chatService.ts) and [`backend/src/modules/retrieval/services/retrievalPipelineService.ts`](/Users/dm/conductor/workspaces/hivec/vendor-agnostic-llm/backend/src/modules/retrieval/services/retrievalPipelineService.ts) MUST remain orchestration-focused and MUST NOT gain vendor SDK imports or provider-conditional logic.
- **New Seams Required**: The feature MUST introduce a provider-neutral registry or factory for model capabilities, explicit adapter ownership for text generation and streaming, embeddings, and structured model-backed operations used by query rewrite and rerank flows, plus focused configuration parsing that maps each capability to a provider/model choice.
- **Anti-Goals**: Do not rewrite the retrieval pipeline around a new framework. Do not expose vendor choice through new end-user UI in this feature. Do not spread provider checks across route handlers or service methods. Do not change the external chat HTTP contract solely to accommodate provider differences. Do not change the constitutional default away from GPT-5.2.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support provider-neutral configuration for model-backed capabilities used by chat answering, chat streaming, embeddings, query rewrite, and reranking.
- **FR-002**: The system MUST preserve GPT-5.2 as the default provider and default model path unless an operator explicitly configures an alternate supported provider.
- **FR-003**: The system MUST support OpenAI, Gemini, Claude, and OpenAI-compatible backends as selectable provider options within the same configuration model.
- **FR-004**: The system MUST isolate provider-specific SDK logic behind focused backend adapters so chat services, retrieval orchestration services, and HTTP routes do not import or branch on vendor SDKs directly.
- **FR-005**: The system MUST allow an operator to select providers and model identifiers per capability without editing application service code.
- **FR-006**: The system MUST preserve the current externally visible chat and retrieval behavior for the default provider, including non-streaming responses, streaming responses, rewrite fallback behavior, rerank fallback behavior, and citation-compatible answer generation.
- **FR-007**: The system MUST normalize streaming output from supported providers into the existing backend stream event behavior consumed by callers.
- **FR-008**: The system MUST validate provider configuration early and fail with clear operator-facing errors when the configured provider is unsupported, incomplete, or mapped to a capability it cannot satisfy.
- **FR-009**: The system MUST keep existing model-backed fallback behavior for malformed or unusable rewrite and rerank outputs even when the backing provider changes.
- **FR-010**: The system MUST update example environment configuration to document the provider-neutral settings and required secrets for each supported provider path introduced by this feature.
- **FR-011**: The system MUST record or surface enough provider and model metadata in logs, diagnostics, or other existing operator-facing mechanisms to identify which configured provider path served a request without exposing secrets.
- **FR-012**: The system MUST keep provider-specific changes additive and responsibility-limited so future provider additions can follow the same adapter pattern without modifying unrelated transport or domain modules.

### Key Entities *(include if feature involves data)*

- **Provider Capability Registry**: The configuration-driven component that resolves which provider adapter and model should serve each model-backed capability.
- **Provider Adapter**: A focused integration module that translates between the system's internal capability contracts and one vendor or protocol-compatible backend.
- **Capability Configuration**: The operator-defined mapping that selects a provider and model identifier for a named capability such as chat, embeddings, rewrite, or rerank.
- **Provider Diagnostics Metadata**: The non-secret operational details that identify the provider and model path used for a request or failure.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can switch from the default provider to at least one alternate supported provider for chat and retrieval-related model calls by changing configuration rather than modifying application service code.
- **SC-002**: Backend tests demonstrate that the default provider path preserves current chat and retrieval behavior and that at least one alternate provider path is exercised through the new provider-neutral seams.
- **SC-003**: No new vendor SDK imports appear in backend route handlers or orchestration services for chat and retrieval after the feature is delivered.
- **SC-004**: Invalid or incomplete provider configuration produces explicit startup or dependency-resolution failures that identify the configuration problem without revealing secret values.
- **SC-005**: Adding another provider following this feature requires changes in provider adapter and configuration modules only, without modifying the external HTTP contract or core orchestration entrypoints.

## Assumptions

- The first delivery will keep the external HTTP API unchanged and will focus on backend configuration and internal modularity.
- OpenAI-compatible support covers backends that expose an OpenAI-like protocol surface, including GPT-oss deployments behind a compatible endpoint.
- The feature may reuse existing gateway concepts, but it should strengthen the composition and provider-capability boundaries rather than merely rename OpenAI-specific classes.
- LangChain is not a required dependency for this feature; if referenced during implementation, it must remain an internal adapter choice rather than the architecture boundary.
