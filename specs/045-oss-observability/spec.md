# Feature Specification: OSS Observability

**Feature Branch**: `045-oss-observability`  
**Created**: 2026-04-22  
**Status**: Draft  
**Input**: User description: "Create an engineering plan for OSS-safe observability, product analytics, and incident reporting for Radioso SaaS without shipping PostHog or Sentry as default open-source dependencies."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Define An OSS-Safe Default Observability Architecture (Priority: P1)

As a Radioso maintainer, I want a clear observability architecture that works
for open source deployments without requiring closed vendor services so the
default product remains self-hostable and operationally credible.

**Why this priority**: This is the core decision. If the architecture assumes a
vendor from day one, the product loses OSS clarity and self-hosting operators
inherit dependencies they may not want.

**Independent Test**: Review the approved spec and confirm it defines default
logging, metrics, tracing, product-event storage, and incident capture behavior
that does not depend on PostHog, Sentry, or any other third-party hosted
service.

**Acceptance Scenarios**:

1. **Given** the approved spec, **When** a maintainer reviews the default
   observability stack, **Then** they can identify an OSS-compatible path for
   logs, metrics, traces, product events, and incident records without enabling
   vendor-specific adapters.
2. **Given** the approved spec, **When** a self-hosting operator reads the
   requirements, **Then** they can understand which observability capabilities
   are available by default and which external integrations are optional.

---

### User Story 2 - Preserve A Single Radioso-Owned Event Model Across OSS And SaaS (Priority: P1)

As a Radioso maintainer, I want product analytics and incident reporting to use
Radioso-owned internal event models so external vendors remain optional sinks
rather than the source of truth.

**Why this priority**: Vendor lock-in happens when event semantics live in a
third-party SDK instead of in the product. This story preserves portability and
keeps future integrations tractable.

**Independent Test**: Review the approved spec and confirm it defines internal
event types, sink boundaries, and source-of-truth rules for analytics and
incident data that remain the same for OSS and SaaS deployments.

**Acceptance Scenarios**:

1. **Given** the approved spec, **When** a maintainer inspects the analytics
   requirements, **Then** product events are defined in Radioso terms rather
   than by a vendor SDK schema.
2. **Given** the approved spec, **When** a maintainer inspects the incident
   reporting requirements, **Then** crashes and failures are normalized into a
   Radioso-owned incident shape before any optional external export occurs.

---

### User Story 3 - Make Modular Ownership Explicit Before Implementation (Priority: P1)

As an engineer planning the work, I want the spec to define module boundaries,
anti-goals, and rollout phases so implementation can proceed without observability
logic leaking into route handlers, chat orchestration, or ad hoc vendor calls.

**Why this priority**: Observability work often sprawls into shared code unless
ownership is explicit. This story protects maintainability before any coding
starts.

**Independent Test**: Review the approved spec and confirm it identifies the
owning layers, responsibility-limited modules, new seams, and phased rollout
needed to implement the design safely.

**Acceptance Scenarios**:

1. **Given** the approved spec, **When** an engineer prepares `plan.md` and
   `tasks.md`, **Then** they can assign ownership for telemetry, analytics, and
   incident reporting without putting vendor logic directly into shared backend
   modules.
2. **Given** the approved spec, **When** an engineer evaluates the rollout,
   **Then** they can sequence interface definition, default sinks, and optional
   adapters without needing to reopen the feature scope.

---

### User Story 4 - Document Operator Expectations For SaaS-Only Adapters (Priority: P2)

As a SaaS operator, I want the plan to clarify which observability adapters are
optional and deployment-scoped so hosted Radioso can use external tools without
changing the default open-source product contract.

**Why this priority**: SaaS requirements matter, but they should not distort
the public product architecture or confuse self-hosters about what is included
by default.

**Independent Test**: Review the approved spec and confirm it distinguishes OSS
defaults from SaaS-only adapters, configuration, and rollout expectations.

**Acceptance Scenarios**:

1. **Given** the approved spec, **When** an operator reads the configuration
   and rollout requirements, **Then** they can tell which adapters are optional
   for hosted deployment and which capabilities are part of the default system.
2. **Given** the approved spec, **When** a maintainer evaluates documentation
   scope, **Then** they can identify which operator-facing docs and runbook
   sections must be updated if implementation proceeds.

### Edge Cases

- What happens when an optional external analytics or incident sink is
  unavailable while Radioso is still serving requests?
- What happens when high-cardinality or sensitive retrieval metadata is
  accidentally eligible for export through telemetry or analytics sinks?
- What happens when OSS and SaaS deployments want different sink combinations
  but must preserve the same internal event semantics?
- What happens when a request failure occurs outside a well-instrumented path
  and would otherwise fall back to ad hoc console logging?
- What happens when product analytics needs a user-facing event but the product
  must not hard-code vendor identifiers or event names into unrelated modules?

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
- Any operator-facing settings, run instructions, or deployment guidance changed by this feature MUST update the corresponding documentation in the same delivery.
- Any backend runtime prompt assets introduced by follow-on implementation MUST live under `backend/prompts/`, though no new runtime prompts are expected in this planning feature.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; this planning feature must avoid proposing any design that depends on hard-coded multilingual conversational copy.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: HTTP transport remains responsible only for request handling and response shaping, chat and ingestion orchestration remain responsible for coordinating product workflows, focused observability modules own telemetry and incident logic, focused analytics modules own product-event definition and sink fan-out, and persistence modules own durable event storage such as audit records.
- **Encapsulation Rule**: Shared route handlers, chat orchestration services, and retrieval orchestration services MUST remain product-flow coordinators and MUST NOT become the permanent home for vendor SDK calls, metrics formatting, or sink-specific export logic. Existing audit persistence modules MUST remain persistence-focused and MUST NOT absorb deployment-specific adapter behavior.
- **New Seams Required**: The plan MUST introduce explicit internal seams for telemetry emission, product analytics emission, and incident reporting, each with default OSS-safe implementations and adapter boundaries for optional external sinks.
- **Anti-Goals**: Do not make PostHog, Sentry, or any other vendor SDK the source of truth for analytics or incident state. Do not spread sink-specific logic across route handlers or frontend components. Do not make external sink availability part of the critical path for serving user requests. Do not export sensitive prompts, retrieved document text, secrets, or raw connector credentials by default.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The feature MUST produce an engineering-ready observability specification for Radioso that covers application telemetry, product analytics, and incident reporting as separate but coordinated concerns.
- **FR-002**: The approved spec MUST define an OSS-compatible default observability path that does not require PostHog, Sentry, or another hosted vendor service to obtain logs, metrics, traces, product events, and incident records.
- **FR-003**: The approved spec MUST define a Radioso-owned internal event model for product analytics that remains authoritative across OSS and SaaS deployments.
- **FR-004**: The approved spec MUST define a Radioso-owned normalized incident model for crashes and failures before any optional external export occurs.
- **FR-005**: The approved spec MUST define sink or adapter boundaries that allow hosted SaaS deployments to enable optional external integrations without changing the product’s default architecture.
- **FR-006**: The approved spec MUST require that default observability behavior continue to function when optional external sinks are disabled, misconfigured, rate-limited, or unavailable.
- **FR-007**: The approved spec MUST define privacy and redaction rules that prevent raw prompts, retrieved document bodies, secrets, session material, and connector credentials from being exported by default.
- **FR-008**: The approved spec MUST define the minimum runtime telemetry needed to observe API health, chat behavior, retrieval-stage behavior, background job behavior, and incident rates.
- **FR-009**: The approved spec MUST define the minimum product analytics event taxonomy needed to observe workspace activation, document processing activity, chat usage, and operator settings changes.
- **FR-010**: The approved spec MUST define the module ownership boundaries for telemetry, analytics, incident reporting, and durable event persistence so later planning can assign implementation tasks without ambiguity.
- **FR-011**: The approved spec MUST identify current gaps in the existing product that the implementation plan must close, including ad hoc unhandled error capture paths.
- **FR-012**: The approved spec MUST define rollout phases that sequence interface creation, default sink behavior, telemetry exposure, and optional adapter support in a way that keeps scope controlled.
- **FR-013**: The approved spec MUST identify the operator-facing and repo-level documentation that will need updates if implementation proceeds, including run flow or environment configuration guidance if new settings are introduced.
- **FR-014**: The approved spec MUST avoid introducing requirements that force frontend or backend product code to hard-code vendor event names or sink-specific payloads outside focused observability modules.
- **FR-015**: The approved spec MUST be detailed enough for a follow-on engineer to create `plan.md` and `tasks.md` without reopening the feature scope or asking foundational architecture questions.

### Key Entities *(include if feature involves data)*

- **Telemetry Event**: A runtime signal used to describe service health, latency, request handling, retrieval stages, and background processing behavior.
- **Product Analytics Event**: A Radioso-owned event describing product usage, operator actions, or workflow milestones such as workspace setup, document processing, and chat completion.
- **Incident Event**: A normalized Radioso-owned record describing an error, crash, or operational failure with enough metadata for correlation and optional external export.
- **Observability Sink**: A default or optional destination that receives telemetry, analytics, or incident events without becoming the source of truth for their schema.
- **Redaction Policy**: The rule set that determines which fields may be emitted, persisted, or exported and which sensitive fields must stay local or be removed.

## Assumptions

- Existing structured logging and audit event storage are the right starting points for the implementation plan rather than a complete replacement.
- The implementation should treat OpenTelemetry and Prometheus-compatible metrics exposure as standards-based infrastructure choices rather than as hosted-vendor commitments.
- This feature stops at an engineering plan and approved spec; no runtime code changes, migrations, or vendor integrations are required in this delivery.
- Optional SaaS adapters may exist in the repository later, but they should be isolated behind focused module boundaries and disabled by default.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reviewer can read the approved spec and identify the default OSS observability path and the optional SaaS adapter path without ambiguity.
- **SC-002**: A reviewer can map telemetry, product analytics, and incident reporting to distinct owning seams and responsibilities with no unresolved architecture questions blocking follow-on planning.
- **SC-003**: The approved spec contains no unresolved clarification markers and no requirement that makes a hosted vendor dependency mandatory for open-source deployment.
- **SC-004**: A follow-on engineer can derive a phased implementation plan, task breakdown, and documentation update list directly from the approved spec without reopening the original problem statement.
