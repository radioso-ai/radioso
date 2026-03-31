# Feature Specification: Split Semantic And Lexical Query Rewrite

**Feature Branch**: `032-split-rewrite-queries`  
**Created**: 2026-03-31  
**Status**: Draft  
**Input**: User description: "Design a feature for workspace-configurable semantic and lexical query rewrite instructions, using one extensible lexical query in phase 1, with retrieval settings API and UI support and retrieval trace visibility."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Retrieve Better With Different Query Shapes (Priority: P1)

As an end user, I want the system to search semantically and lexically with query forms suited to each retrieval method so that literal citations, corpus-native notation, and abbreviations can be found without weakening semantic matching.

**Why this priority**: This is the core user-facing retrieval improvement. Without distinct semantic and lexical query shaping, the feature does not address the exact failure mode it is intended to solve.

**Independent Test**: Can be fully tested by enabling the feature for a workspace, running retrieval queries against a corpus that uses notation variants such as symbols, abbreviations, or citation forms, and verifying that the lexical query differs from the semantic query where appropriate while relevant evidence appears in retrieval results.

**Acceptance Scenarios**:

1. **Given** a workspace with query rewrite enabled and rewrite instructions configured, **When** a user asks a query whose semantic meaning and lexical corpus form differ, **Then** the system produces separate semantic and lexical retrieval queries and uses them in the existing hybrid retrieval flow.
2. **Given** a user query that already matches the best retrieval wording, **When** retrieval runs, **Then** the system preserves a stable semantic and lexical query without unnecessary drift from the original query.
3. **Given** a query involving citation-like language such as legal section references, abbreviations, or corpus-native symbols, **When** lexical rewrite guidance applies, **Then** the lexical query prefers the notation likely to appear in indexed text while the semantic query remains meaning-preserving.
4. **Given** a standalone retrieval request with no prior conversation history, **When** rewrite is enabled and split rewrite instructions are configured, **Then** the system may still produce distinct semantic and lexical retrieval queries without depending on history-only subject resolution.

---

### User Story 2 - Configure Rewrite Behavior Per Workspace (Priority: P2)

As a workspace admin, I want to configure semantic and lexical rewrite instructions in retrieval settings so that each workspace can tune retrieval toward its own notation, aliases, and domain-specific wording without code changes.

**Why this priority**: The feature is only operationally useful if the rewrite behavior is configurable where retrieval settings already live, rather than being hard-coded per deployment.

**Independent Test**: Can be fully tested by updating retrieval settings through the authenticated settings API and admin UI, reloading the settings, and verifying that the configured rewrite instructions are persisted and later affect retrieval behavior only for that workspace.

**Acceptance Scenarios**:

1. **Given** a workspace admin opens retrieval settings, **When** they view the query rewrite section, **Then** they can edit separate semantic and lexical rewrite instructions in plain language.
2. **Given** a workspace admin saves retrieval settings with custom semantic and lexical rewrite instructions, **When** retrieval settings are fetched again later, **Then** the same instruction values are returned unchanged.
3. **Given** one workspace stores custom rewrite instructions and another workspace does not, **When** both workspaces run retrieval, **Then** each workspace uses only its own configured rewrite behavior.

---

### User Story 3 - Inspect Rewrite Outputs In Retrieval Diagnostics (Priority: P3)

As an operator debugging retrieval quality, I want retrieval trace and diagnostics to show the original query, the semantic query, the lexical query, and any fallback reason so that I can tell whether rewrite behavior helped or hurt a search.

**Why this priority**: Distinct query shaping introduces another retrieval decision point. Without observability, quality tuning becomes guesswork.

**Independent Test**: Can be fully tested by running representative queries through the existing retrieval trace surface and verifying that the recorded and displayed rewrite outputs match the retrieval execution for the corresponding request.

**Acceptance Scenarios**:

1. **Given** a retrieval request where distinct semantic and lexical queries are produced, **When** diagnostics are recorded, **Then** the trace shows the original query, semantic query, lexical query, rewrite status, and whether the rewritten queries were used.
2. **Given** rewrite is disabled, rejected, or falls back, **When** diagnostics are recorded, **Then** the trace shows the fallback status and the effective semantic and lexical queries used for retrieval.
3. **Given** a workspace admin reviews retrieval trace details in the product, **When** they inspect rewrite information, **Then** they can understand the retrieval query split without reading raw backend logs.

### Edge Cases

- What happens when semantic and lexical rewrite instructions are blank, whitespace-only, or omitted by an older client?
- What happens when the rewrite model returns an unusable lexical or semantic query, such as an empty string, a query longer than the allowed limit, or content that ignores the original subject?
- How does the system behave when query rewrite is disabled globally for the workspace but instruction fields are still present in saved settings?
- What happens when the original query should remain identical for one retrieval mode but change for the other?
- How does the system handle older workspaces that have only the existing `queryRewriteEnabled` setting and no explicit split-query instructions yet?

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
- Backend API contracts MUST remain code-first and any HTTP contract change must regenerate generated OpenAPI artifacts instead of hand-editing them.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Retrieval settings routes and presenters own transport and API contracts; retrieval settings services and domain validation own persistence-facing settings behavior; query interpretation and query rewrite services own rewrite decision-making; candidate retrieval stages consume the resulting semantic and lexical queries but do not invent their own rewrite logic.
- **Encapsulation Rule**: `backend/src/modules/retrieval/services/queryInterpretationStage.ts` MUST remain the orchestration point that decides which active semantic and lexical queries move downstream, while `backend/src/modules/retrieval/services/queryRewriteService.ts` or a focused rewrite companion module MUST own rewrite prompting, normalization, and fallback decisions. `frontend/components/dashboard/settings/retrieval-settings-panel.tsx` MUST remain a presentation container rather than owning rewrite semantics or validation policy.
- **New Seams Required**: Introduce a focused settings representation for split rewrite instructions, a rewrite output contract that can carry distinct semantic and lexical query strings, and a clear normalization/fallback seam that allows future expansion to multiple lexical variants without reshaping the full retrieval pipeline.
- **Anti-Goals**: Do not add deterministic rewrite rule engines in this feature. Do not move query-shaping logic into candidate retrieval, trace assembly, or chat services. Do not introduce multiple lexical variants in execution for phase 1. Do not replace the existing `queryRewriteEnabled` toggle with an always-on behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST allow a workspace to store separate semantic rewrite instructions and lexical rewrite instructions as part of retrieval settings.
- **FR-002**: The system MUST expose those split rewrite instruction fields through the authenticated retrieval settings API and persist them per workspace.
- **FR-003**: The system MUST present those split rewrite instruction fields in the retrieval settings UI in operator-friendly language that explains the difference between semantic and lexical query shaping.
- **FR-004**: The system MUST preserve the existing workspace-level `queryRewriteEnabled` control so admins can still enable or disable query rewriting without deleting their saved instructions.
- **FR-005**: When query rewrite is enabled and a rewrite is accepted for retrieval use, the system MUST produce an active semantic query and an active lexical query that may differ from each other.
- **FR-006**: The system MUST allow one retrieval mode to keep the original query while the other retrieval mode uses a rewritten query when that is the best supported outcome for the request.
- **FR-007**: The system MUST use the active semantic query for semantic retrieval stages and the active lexical query for lexical retrieval stages without changing the existing caller-facing retrieval pipeline contract.
- **FR-008**: The system MUST keep phase 1 execution limited to one semantic query and one lexical query per request while defining contracts that can be extended later to support multiple lexical variants.
- **FR-009**: The system MUST preserve current safe fallback behavior when rewrite is disabled, rejected, fails, or yields unusable output, including continuing retrieval with stable effective queries.
- **FR-010**: The system MUST validate split rewrite instruction fields so invalid payload shapes fail safely and older clients that omit the new fields still receive usable retrieval settings defaults.
- **FR-011**: The system MUST define safe default semantic and lexical rewrite instructions for workspaces that have not configured custom values.
- **FR-012**: The system MUST ensure the semantic rewrite guidance stays meaning-preserving and standalone-query oriented rather than optimizing primarily for corpus notation.
- **FR-013**: The system MUST ensure the lexical rewrite guidance can prefer corpus-native notation, abbreviations, aliases, citation forms, or exact literals when those forms are more likely to match indexed text.
- **FR-014**: The system MUST record retrieval diagnostics that identify the original query, active semantic query, active lexical query, rewrite status, and any rejection or fallback reason.
- **FR-015**: The system MUST make the split-query rewrite outputs visible in the existing retrieval trace or retrieval information experience for executed requests.
- **FR-016**: The system MUST keep split rewrite behavior workspace-scoped so one workspace’s rewrite instructions do not affect another workspace.
- **FR-017**: The system MUST preserve compatibility for existing retrieval settings records and retrieval requests that predate the split-query instruction fields.
- **FR-018**: The system MUST NOT require deterministic normalization rules, custom per-workspace code, or user-authored scripting in this feature.
- **FR-019**: The system MUST allow standalone retrieval requests with no prior conversation history to use semantic and lexical rewrite instructions when query rewrite is enabled, while avoiding history-dependent referential inference that lacks grounding.

### UI Tasks

- The retrieval settings screen must explain, in plain language, that semantic rewrite instructions shape meaning-oriented search and lexical rewrite instructions shape exact-term or notation-oriented search.
- The retrieval settings screen must allow admins to edit semantic rewrite instructions and lexical rewrite instructions independently.
- The retrieval settings screen must preserve the existing query rewrite enable/disable toggle alongside the new instruction fields.
- The retrieval settings screen must communicate that phase 1 executes one semantic query and one lexical query per request, even though the model may evolve later.
- The retrieval trace or retrieval information experience must show the original query, semantic query, lexical query, rewrite status, and fallback reason in readable product language.

### Key Entities *(include if feature involves data)*

- **Split Rewrite Settings**: The workspace-scoped retrieval settings fields that define semantic rewrite instructions, lexical rewrite instructions, and the existing rewrite enablement toggle.
- **Split Rewrite Result**: The normalized rewrite output for one request, including the original query, semantic query, lexical query, status, and fallback or rejection reasons.
- **Active Retrieval Queries**: The semantic and lexical query strings selected by the query interpretation stage for downstream retrieval execution.
- **Rewrite Trace Record**: The bounded diagnostics representation that surfaces split-query rewrite behavior in retrieval information and trace views.

## Assumptions

- The existing retrieval rewrite flow already provides the correct pipeline seam for this feature, so the work can build on current query-interpretation and trace infrastructure rather than redesigning retrieval orchestration.
- Standalone retrieval requests without prior history can still benefit from notation- or alias-oriented rewriting, even though they do not allow subject resolution from conversation context.
- Phase 1 needs only one lexical query in execution, but the data model and internal contracts should avoid blocking later support for multiple lexical variants.
- Default instructions may be system-defined so that existing workspaces receive usable behavior without mandatory admin setup.
- The existing retrieval settings API can expand additively to carry the new fields without introducing a new endpoint.
- Retrieval trace and diagnostics can be extended additively rather than replaced.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Covered retrieval tests demonstrate that the system can execute with distinct semantic and lexical queries for representative notation-sensitive queries while preserving current retrieval behavior when no split is needed.
- **SC-002**: Covered settings API and persistence tests confirm that 100% of saved semantic and lexical rewrite instruction values round-trip correctly per workspace, including older clients that omit the new fields.
- **SC-003**: Covered UI tests or acceptance verification confirm that workspace admins can view, edit, save, and reload the two rewrite-instruction fields and the existing rewrite toggle in retrieval settings.
- **SC-004**: Covered diagnostics tests confirm that 100% of retrieval executions expose the original query, semantic query, lexical query, rewrite status, and fallback or rejection reason when applicable.
- **SC-005**: Regression coverage confirms that existing workspaces with query rewrite disabled or unset continue to produce stable retrieval results without contract regressions.
