# Feature Specification: Skills Catalog Diagnostics

**Feature Branch**: `059-skills-catalog-diagnostics`  
**Created**: 2026-05-07  
**Status**: Draft  
**Input**: User description: "Add a read-only Radioso skills catalog and shared skill diagnostic definitions. Inventory existing proto-skills, assign stable skill names, describe supported caller surfaces and required capabilities, and define diagnostics for future skill execution without adding generic skill execution or retrieval strategy execution."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Discover Supported Skills (Priority: P1)

An integrator can discover the stable skills Radioso currently exposes and understand which existing product surface owns each skill.

**Why this priority**: This creates the first useful product model for skills without changing execution behavior. It lets SDK, MCP, and API users understand what Radioso can do before adopting future skill execution flows.

**Independent Test**: Can be fully tested by requesting the skills catalog and verifying that it lists the approved proto-skills with stable names, purposes, owner surfaces, execution classes, and related existing contracts.

**Acceptance Scenarios**:

1. **Given** a workspace has the default Radioso capabilities available, **When** a caller requests the skills catalog, **Then** the response lists the approved built-in skills with stable identifiers and concise descriptions.
2. **Given** a caller inspects a catalog entry, **When** the entry is returned, **Then** it identifies the existing contract or surface the caller should use today rather than implying that a generic skill executor exists.
3. **Given** a skill is not available in the current composition, **When** the catalog is returned, **Then** the catalog either omits that skill or marks it unavailable with a clear reason and without exposing implementation details.

---

### User Story 2 - Understand Capability And Surface Fit (Priority: P2)

An MCP, SDK, or API client can inspect the capabilities and supported caller surfaces for each skill before choosing how to invoke current Radioso contracts.

**Why this priority**: Skills must not bypass the capability policy model or blur assistant, retrieval, SDK, and MCP boundaries. Callers need enough metadata to select the correct surface.

**Independent Test**: Can be fully tested by comparing catalog entries for assistant, retrieval, document, and MCP-oriented skills and verifying that each entry states the supported caller surfaces and required capabilities.

**Acceptance Scenarios**:

1. **Given** a skill can be used by retrieval-only clients, **When** a caller reads its catalog entry, **Then** the entry indicates that assistant chat is not required.
2. **Given** a skill is intended for assistant-mediated chat behavior, **When** a caller reads its catalog entry, **Then** the entry identifies assistant as the owning surface and does not present the skill as a retrieval-only contract.
3. **Given** a skill depends on one or more internal capabilities, **When** its catalog entry is returned, **Then** the entry names those capabilities using the shared capability catalog rather than inventing ad hoc permission strings.

---

### User Story 3 - Standardize Skill Diagnostics (Priority: P3)

An operator or engineer can read one diagnostic definition for skill execution metadata before later features begin emitting strategy-aware skill diagnostics.

**Why this priority**: Radioso can only expand skills safely if probabilistic choices stay inspectable. Defining diagnostics before adding autonomy keeps future execution work bounded.

**Independent Test**: Can be fully tested by inspecting the documented diagnostic schema and verifying that it covers deterministic execution, probabilistic selection, retrieval strategy metadata, capability checks, fallback, evidence status, and caller surface.

**Acceptance Scenarios**:

1. **Given** a future deterministic skill executes, **When** its diagnostics follow this definition, **Then** an operator can see the selected skill, capability checks, caller surface, outcome, and fallback if any.
2. **Given** a future probabilistic skill executes, **When** its diagnostics follow this definition, **Then** an operator can see the selected strategy, selection confidence or reason, relevant parameters, outcome, and fallback if any.
3. **Given** a future retrieval answer skill uses a specialized retrieval strategy, **When** diagnostics are inspected, **Then** the metadata can represent query shape, selected retrieval strategy, evidence status, support status, and ranking or reranking choices without changing the user-facing answer contract.

### Edge Cases

- What happens when a skill is known to Radioso but disabled by the current application composition?
- What happens when a catalog entry references a capability that is not granted to the caller?
- What happens when an existing proto-skill does not yet have enough metadata to describe every diagnostic field?
- What happens when a future skill has no retrieval behavior and therefore no evidence or support metadata?
- What happens when MCP needs catalog metadata but should not be forced through assistant chat?
- What happens when a caller requests an unknown skill name?

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
- Public contract changes MUST update the code-first OpenAPI registry and generated OpenAPI artifacts.
- Public contract changes MUST include message-queue impact review.
- Documentation that explains skills, capability policy, SDK usage, MCP usage, or public API behavior MUST be updated in the same change.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport owns HTTP adaptation only; the skill catalog owner owns catalog entry assembly and skill diagnostic definitions; application composition owns default registration; existing assistant, retrieval, document, handoff, and email modules continue to own their product behavior; capability policy remains the source of availability and permission checks.
- **Encapsulation Rule**: Retrieval services must not become the owner of the global skill catalog. Assistant chat must not become the generic skill executor. MCP capability discovery must not invent a separate skill vocabulary. Route handlers must not construct catalog entries inline.
- **New Seams Required**: A focused skills catalog or platform catalog seam that can register built-in skill metadata, expose read-only catalog views, and share diagnostic type definitions without executing skills. A mapping from skill entries to existing public contracts is required.
- **Anti-Goals**: Do not add generic skill execution in this feature. Do not implement retrieval strategy selection in this feature. Do not replace existing assistant or retrieval endpoints. Do not expose every internal capability as a public skill. Do not add new external connector workflows. Do not let skill metadata bypass existing capability policy.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST define stable skill names for the approved built-in proto-skills included in this feature.
- **FR-002**: System MUST expose a read-only skills catalog that lists available built-in skills for the active application composition.
- **FR-003**: System MUST expose a read-only detail view for one known skill.
- **FR-004**: Each skill catalog entry MUST include a stable skill identifier, display name, short purpose, owner surface or module, execution class, availability state, supported caller surfaces, required capabilities, and related existing contract references.
- **FR-005**: Catalog entries MUST distinguish product-facing skills from internal capabilities.
- **FR-006**: Catalog entries MUST make clear when a skill is currently invoked through an existing assistant, retrieval, document, settings, SDK, or MCP surface rather than through generic skill execution.
- **FR-007**: Catalog entries MUST use capability names from the shared capability catalog when required capabilities are listed.
- **FR-008**: System MUST define a shared skill diagnostic shape that can represent selected skill, selected strategy when applicable, deterministic or probabilistic selection mode, selection reason or confidence when available, capability checks, caller surface, fallback, outcome, and error or unsupported status.
- **FR-009**: The diagnostic definition MUST support retrieval-specific metadata including query shape, retrieval strategy, evidence status, support status, candidate source summary, ranking or reranking choices, and grounding outcome.
- **FR-010**: The diagnostic definition MUST support deterministic skills that have no strategy, no retrieval evidence, and no LLM selection confidence.
- **FR-011**: Unknown skill detail requests MUST return a stable not-found error shape.
- **FR-012**: Unavailable skills MUST be represented without leaking secrets, deployment internals, or disabled provider configuration.
- **FR-013**: MCP-facing capability discovery MUST be able to reference the same skill vocabulary or catalog metadata without forcing MCP clients through assistant chat.
- **FR-014**: The TypeScript SDK documentation or contracts MUST describe how SDK users can discover skills without implying generic skill execution.
- **FR-015**: Product documentation MUST explain the relationship between skills, capabilities, intents, strategies, and agents.
- **FR-016**: The feature MUST include contract coverage for the skills catalog list, skill detail, unknown skill, and capability metadata behavior.
- **FR-017**: The feature MUST include unit coverage for catalog assembly and diagnostic shape validation.
- **FR-018**: The feature MUST include a message-queue impact review and state whether document worker dispatch, AMQP payloads, retry semantics, queue tests, or queue docs are affected.

### Key Entities

- **Skill Catalog Entry**: A stable description of a product-facing skill, including name, purpose, availability, supported caller surfaces, required capabilities, and related existing contracts.
- **Skill Diagnostic Definition**: A shared metadata shape that describes how a skill execution should report selection, strategy, capability checks, fallback, outcome, and evidence or support status.
- **Skill Availability**: The visible state of a skill in the current application composition, including whether it is available, unavailable, or hidden from the caller.
- **Skill Contract Reference**: A pointer to the existing public surface used to invoke a skill today, such as assistant chat, retrieval answer, retrieval search, document ingestion, MCP, or SDK methods.
- **Capability Requirement**: The shared capability policy requirement that must be satisfied before a caller can use or see full metadata for a skill.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A caller can retrieve the default skills catalog and identify the stable name, purpose, owner surface, supported caller surfaces, and related current contract for every included built-in skill.
- **SC-002**: A caller can request one skill detail by stable name and receive the same canonical metadata as the catalog list.
- **SC-003**: Unknown skill requests return a stable not-found response that contract tests verify.
- **SC-004**: Every included catalog entry lists required capabilities from the shared capability catalog or explicitly states that no capability requirement is exposed in the catalog.
- **SC-005**: The diagnostic definition can represent at least one deterministic skill, one retrieval answer skill with strategy metadata, and one unsupported or fallback outcome in tests or documented examples.
- **SC-006**: MCP and SDK documentation describe skill discovery without requiring assistant chat or generic skill execution.
- **SC-007**: The feature changes no retrieval ranking, assistant routing, document ingestion, handoff delivery, or email delivery behavior.
- **SC-008**: OpenAPI and backend contract tests stay aligned for all new or changed public API responses.
