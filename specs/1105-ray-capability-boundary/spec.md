# Feature Specification: Ray Capability and Authorization Boundary

**Feature Branch**: `evaluate-issue-1105`
**Created**: 2026-08-28
**Status**: Approved
**Input**: GitHub issue #1105 and the approved requirement that Ray inherit existing workspace role permissions without becoming an independent authorization surface.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Preserve operator least privilege in Ray (Priority: P1)

As an operator, I can use Ray only for capabilities my current workspace role already permits, so opening a Ray conversation never gives me a more privileged path than the ordinary operator surfaces.

**Why this priority**: A model-facing surface that weakens authorization creates a security boundary failure even when the underlying operation is otherwise safe.

**Independent Test**: Give operators different workspace roles, attempt the same Ray capability and its ordinary non-Ray equivalent, and verify that Ray is never less restrictive.

**Acceptance Scenarios**:

1. **Given** an operator whose role lacks a capability's required permission, **When** Ray prepares or executes a turn, **Then** that capability is unavailable and cannot be invoked.
2. **Given** an operator whose role changes while a Ray turn or pending proposal exists, **When** Ray next resolves an entity, reads descriptor-owned data, creates a proposal, invokes a capability, or applies a proposal, **Then** the current role permissions are enforced before any protected data or mutation is produced.
3. **Given** a deterministic, non-mutating routine validation, **When** an operator has agent-read permission but not agent-management permission, **Then** validation is equally available through Ray and the ordinary operator surface.
4. **Given** an operator who may create a proposal but may no longer apply it, **When** application is attempted, **Then** the proposal remains unapplied and no domain mutation occurs.

---

### User Story 2 - Make every Ray capability accountable to an existing surface (Priority: P1)

As a maintainer or reviewer, I can determine which existing operator capabilities a Ray tool represents and which additional orchestration is intentionally Ray-only, so accidental domain powers cannot enter the model catalog unnoticed.

**Why this priority**: Capability provenance is the enforceable form of the product boundary; documentation alone cannot prevent drift.

**Independent Test**: Assemble the production Ray catalog and verify that every descriptor has valid backing capabilities or a reviewed Ray-only orchestration disposition, while every named backing operation and descriptor exists.

**Acceptance Scenarios**:

1. **Given** a newly assembled Ray descriptor with neither backing identities nor a reviewed Ray-only disposition, **When** governance checks run, **Then** they fail.
2. **Given** a provenance declaration naming a missing descriptor, nonexistent public operation, or application primitive that does not resolve to an owning-module registry or exported port, **When** governance checks run, **Then** they fail.
3. **Given** a one-to-one Ray representation of an ordinary operation, **When** its permissions are weaker than the ordinary operation, **Then** governance checks fail.
4. **Given** a composed or Ray-only workflow, **When** it declares its backing primitives, permission behavior, disposition, and reason, **Then** governance checks accept it.

---

### User Story 3 - Keep domain rules in their owning modules (Priority: P2)

As a maintainer, I can change Ray orchestration without moving routine, chat, document, or embedding business rules into application composition or bypassing the owning module's application boundary.

**Why this priority**: Authorization parity is fragile if Ray reaches persistence directly or composition becomes a second owner of lifecycle rules.

**Independent Test**: Run architecture-boundary checks that reject prohibited repository dependencies and verify proposal flows through the owning application services.

**Acceptance Scenarios**:

1. **Given** routine proposal preparation and application, **When** lifecycle eligibility, validation, conflicts, and writes are evaluated, **Then** routine-owned rules remain authoritative and application composition only assembles implementations.
2. **Given** Ray reads conversation identity, routine state, document sources, or embedding coverage, **When** those reads execute, **Then** they use the owning module's narrow service or port rather than a Ray-specific repository bypass.
3. **Given** proposal-only optimistic guards, **When** reverse coverage is reviewed, **Then** the stronger conditional-write behavior is recorded as Ray-only proposal safety rather than misrepresented as a separate domain mutation.

---

### User Story 4 - Keep public contracts complete and truthful (Priority: P2)

As an API or SDK consumer, I can rely on the published operator contract to describe the available eval operations and the state-changing nature of Ray turns accurately.

**Why this priority**: Reverse capability coverage cannot be enforced against an incomplete public contract, and generated clients must not describe state-changing work as read-only.

**Independent Test**: Compare live operator eval routes with the published contract, regenerate all dependent snapshots, and verify that Ray's turn description acknowledges eval and proposal persistence.

**Acceptance Scenarios**:

1. **Given** a live operator eval route, **When** the public contract is generated, **Then** the route has a unique operation identity and accurate request, response, and authorization semantics.
2. **Given** the `eval_results` Ray capability, **When** its provenance is inspected, **Then** it refers to the eval-case listing operation rather than the source-message lookup.
3. **Given** a Ray turn that may create eval records or pending proposals, **When** its public description is read, **Then** it is not described as read-only.
4. **Given** an updated public contract, **When** generated SDK and MCP contract checks run, **Then** all committed snapshots agree with the backend contract.

### Edge Cases

- An operator loses a required permission after the model has selected a tool but before descriptor-owned entity resolution, labeling, preflight reads, proposal creation, or invocation.
- An operator loses a required permission after creating a pending proposal but before applying it.
- A composed tool can read some, but not all, contributing sources; unauthorized sections must remain distinguishable from empty or failed sections.
- A tool has both ordinary backing operations and additional Ray-only orchestration.
- A descriptor is renamed or removed while stale forward or reverse coverage remains.
- A public operation is renamed, removed, or added without updating capability provenance.
- Multiple backing operations require different permissions; Ray must not treat any-of authorization as all-of authorization.
- A proposal write uses stronger optimistic concurrency guards than the ordinary dashboard path.
- A denied invocation must not expose prompts, tool inputs, document content, credentials, or other sensitive context in logs or audit records.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend development MUST follow TDD: each behavior or boundary check is written and observed failing before its implementation.
- Existing workspace roles and permissions MUST remain the only source of positive authority; Ray MUST NOT introduce a parallel role system or grant permissions.
- Customer data MUST remain protected through least privilege, current-permission checks, safe failure, and content-free authorization telemetry.
- Public HTTP contract changes MUST originate in the code-first contract and regenerate backend, TypeScript SDK, and MCP snapshots.
- Contract review MUST state that document-worker dispatch, AMQP payloads, retries, and queue semantics are unaffected unless discovery proves otherwise.
- Durable architecture documentation MUST be updated in the same change.
- No frontend or user-facing conversational copy is planned. If implementation discovery changes that, the spec must be revised before adding UI or hard-coded assistant responses.
- Application composition MUST assemble implementations only; product policy belongs to the owning domain or Ray orchestration module.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Existing workspace authorization grants positive authority. Operator Copilot owns model-safe capability declarations, bounded projections, Ray conversations, proposal evidence, pending proposals, and explicitly declared Ray-only orchestration. Owning application modules retain domain reads, mutations, lifecycle rules, and persistence access. HTTP owns transport contracts and authorization middleware. Application composition supplies concrete implementations without owning product policy.
- **Encapsulation Rule**: `backend/src/app/composition/` must remain construction-only. Repositories remain persistence adapters and must not become direct Ray dependencies where an owning application service or port exists. The standalone MCP surface must not infer capability parity merely from reuse of an internal service.
- **New Seams Required**: Every assembled descriptor needs typed capability provenance; public operations and application primitives need machine-checkable identity sources; permission parity needs a machine-checkable source; chat needs a narrow conversation-identity read boundary; documents need a shared source-query boundary; existing routine and embedding read boundaries must be reused.
- **Anti-Goals**: Do not create Ray-specific roles, duplicate domain lifecycle rules, place HTTP/OpenAPI mechanics inside domain services, create one bespoke wrapper per Ray descriptor, expose proposal safety guards publicly without a separate product requirement, or treat an internal service call alone as proof of non-Ray capability parity.

### Ownership Questions

- **What does each area know?** Operator Copilot knows what it composes and why; it does not know repository layout or redefine domain eligibility. Owning modules know domain state and rules; they do not know model catalog behavior. Composition knows concrete implementations; it does not decide product outcomes. HTTP knows operation identity and transport authorization; it does not own domain policy.
- **What ports are exposed, and to whom?** Narrow read ports expose conversation identity, routine state, document-source summaries, and embedding coverage to Operator Copilot and any other application consumers. Domain mutation remains behind existing application services. Capability provenance is exposed to catalog governance and future transports without granting execution authority.
- **What is the dependency direction?** Transport and Operator Copilot orchestration depend on narrow owning-module contracts. Composition depends on both contracts and implementations to assemble them. Owning domains and persistence never depend on Operator Copilot or composition.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Ray MUST derive every operator entitlement from the operator's current existing workspace permissions.
- **FR-002**: Ray MUST NOT define an independent role or permission that grants domain authority unavailable through ordinary operator authorization.
- **FR-003**: A Ray tool MUST be exposed only when the operator holds every permission the descriptor requires.
- **FR-004**: Authorization MUST be checked using current permissions before every descriptor-owned protected read or effect, including entity lookup and resolution, dynamic label or handoff enrichment, preflight reads, proposal creation, tool invocation, and any other descriptor hook that can derive protected data. Data derived under stale permissions MUST NOT be emitted to the model, dashboard, logs, or proposal records.
- **FR-005**: Pending proposal application MUST re-authorize the current operator and MUST fail safely without mutation when required permission is absent.
- **FR-006**: A deny-only Ray policy MAY further restrict catalog availability in the future, but it MUST NOT grant authority and no new configurable policy surface is part of this feature.
- **FR-007**: Every production Ray descriptor MUST declare either exact backing public operations or typed application primitives, or an explicit reviewed Ray-only orchestration disposition with a non-empty reason. A composed descriptor MAY declare both backing identities and an additional Ray-only orchestration disposition.
- **FR-008**: A descriptor that performs entirely Ray-owned orchestration MAY satisfy capability provenance solely through its explicit reviewed disposition and reason; it MUST NOT invent a backing operation or primitive.
- **FR-009**: Governance checks MUST enumerate the assembled production descriptor catalog and reject missing coverage, unknown descriptor names, unknown public operation identities, application-primitive identities that do not resolve against a machine-checkable owning-module registry or exported port, duplicate or contradictory declarations, and empty reasons.
- **FR-010**: Forward coverage MUST continue to account for every registered public operation through a real Ray descriptor or a stated exclusion.
- **FR-011**: When one Ray tool represents one public operation, the Ray tool MUST require equivalent or stronger permissions, with no implicit exception.
- **FR-012**: Composed tools MUST declare all-of permissions for their atomic execution or preserve per-source authorization and distinguish unauthorized sources from empty or failed sources.
- **FR-013**: `validate_routine` and ordinary routine validation MUST both allow agent-read authorization because the operation is deterministic and non-mutating.
- **FR-014**: Routine proposal preparation and application policy MUST live in Operator Copilot or behind a routine-owned preparation port; application composition MUST only construct and wire the adapter.
- **FR-015**: Routine lifecycle validation and mutation MUST remain authoritative in the routine application service.
- **FR-016**: Agent-turn probe reads MUST use owning application boundaries for conversation identity and routine state rather than direct repository dependencies.
- **FR-017**: Document-source reads used by REST, Ray, and skill capability targets MUST share a documents-owned query boundary.
- **FR-018**: Embedding coverage used by Ray MUST reuse the existing embedding coverage read boundary.
- **FR-019**: Proposal-only routine concurrency and discarded-draft guards MUST be declared as Ray-only proposal safety unless a separate requirement makes them part of the public routine contract.
- **FR-020**: `workspace_triage`, safe-test turn orchestration, eval replay with proposal evidence, and proposal creation MUST have explicit orchestration dispositions describing their backing primitives and permission behavior.
- **FR-021**: Every live operator eval route MUST be registered in the public contract with a unique operation identity and accurate schemas and authorization semantics.
- **FR-022**: `eval_results` MUST map to the eval-case listing capability it actually represents.
- **FR-023**: `turn_trace`, `replay_eval_case`, `test_agent_turn`, and `workspace_triage` MUST have complete reverse capability declarations.
- **FR-024**: The Ray turn contract MUST acknowledge that a turn can persist Ray-owned eval records and pending proposals and MUST NOT describe the turn as read-only.
- **FR-025**: Backend, TypeScript SDK, and MCP generated contract snapshots MUST be regenerated from the same code-first contract.
- **FR-026**: Durable architecture documentation MUST state the capability boundary, permissible Ray-only orchestration, authorization rules, proposal-guard decision, and standalone MCP non-inference rule.
- **FR-027**: Authorization failures and proposal denials MUST preserve existing safe audit and telemetry behavior without recording prompts, completions, tool inputs, document content, retrieved chunks, tokens, credentials, cookies, or connection strings.
- **FR-028**: The change MUST preserve existing Ray tool/proposal audit semantics and deterministic behavior selection unless a requirement above intentionally changes authorization or capability availability.

### Key Entities

- **Ray Capability Declaration**: A descriptor's name, required permissions, either backing public operations or registered owning-module application primitives, or a reviewed Ray-only disposition; composed descriptors may declare both backing identities and additional Ray-only orchestration.
- **Orchestration Disposition**: A reviewed statement explaining why a composition, projection, proposal guard, or persistence effect belongs uniquely to Ray while domain authority remains elsewhere.
- **Application Primitive Identity**: A stable identity that resolves through a machine-checkable owning-module registry or exported port and names a non-Ray application capability without coupling Ray to persistence.
- **Effective Operator Entitlement**: The current existing workspace permissions available to authorize a Ray invocation or proposal application; it never exceeds the operator's ordinary authority.
- **Pending Proposal**: A Ray-owned review artifact that describes a possible domain change but grants no authority to apply it.
- **Public Operation Identity**: The stable contract identity used to prove that an underlying non-Ray capability exists and to compare authorization requirements.

## Assumptions

- Existing workspace roles already resolve to the account permissions used by Ray descriptors and HTTP middleware.
- No new database schema, configurable Ray role, custom-role UI, or workspace policy editor is required.
- Proposal creation may remain Ray-owned, but application always delegates to an owning application service after current authorization succeeds.
- Stronger conditional writes used for proposal safety remain Ray-only in this feature.
- All currently live operator eval routes are intended public operator capabilities and should be represented in the generated contract.
- The change affects no worker dispatch, AMQP payload, retry, or queue contract.
- No new metrics are required for static governance checks. Any new runtime authorization denial path reuses or minimally extends existing content-free audit/telemetry conventions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The automated authorization matrix evaluates every supported workspace role against every assembled production descriptor, including every relevant single-permission grant and revocation vector for multi-permission descriptors, and finds zero unauthorized catalog exposure, descriptor-owned reads, proposal creation, or execution.
- **SC-002**: 100% of production Ray descriptors have machine-validated capability provenance and permission behavior.
- **SC-003**: 100% of registered public operations remain forward-covered or explicitly excluded, and 100% of named backing operation identities resolve to the generated public contract.
- **SC-004**: Operators whose role changes before invocation or proposal application receive a safe authorization denial with zero unauthorized domain mutations.
- **SC-005**: Routine validation produces the same authorization outcome through Ray and the ordinary operator surface for agent-read operators.
- **SC-006**: 100% of live operator eval routes appear in the generated public contract and all committed backend, SDK, and MCP snapshots agree.
- **SC-007**: Automated architecture checks find zero prohibited direct Ray dependencies on conversation, routine, document-source, or embedding repositories after the change.
- **SC-008**: Existing deterministic Ray behavior tests pass with no unintended changes to tool selection or never-list behavior.
- **SC-009**: Authorization and proposal-denial diagnostics contain zero prompts, completions, tool inputs, document content, retrieved chunks, tokens, credentials, cookies, or connection strings.
