# Feature Specification: External Skills via MCP

**Feature Branch**: `087-external-skills-mcp`  
**Created**: 2026-06-14  
**Status**: Draft  
**Input**: User description: "External skills via MCP: a generic, data-driven capability to use external MCP server tools as Radioso skills behind the existing skill port (peer to retrieval). Authors define reusable MCP connections and named skill definitions that bind one discovered MCP tool with preset and exposed params, then reference them in routines by name."

> Design source of truth: `.context/calcom-routine-poc-design.md` (validated design, spike findings with path:line evidence, canonical goal, code-vs-data split). This spec must stay consistent with it.

## User Scenarios & Testing *(mandatory)*

The product goal is a **generic, data-driven** capability: the deliverable is the engine ("the theme"); every integration (Slack, a scheduling tool, etc.) is **data an author enters**, never provider-specific code. Stories are sliced so each is an independently shippable MVP increment.

### User Story 1 - Define and use an external skill in a routine (Priority: P1)

An author connects an external MCP server, defines a named skill that binds one of the server's discovered tools (with some inputs pre-set and the rest left for the conversation to fill), and references that skill inside a routine. When the routine reaches that step it calls the external tool and continues based on whether the call succeeded or failed.

Concretely: the author registers a connection (server address + a static access token), picks a discovered tool such as `post_message`, pre-sets `channel = #support`, leaves `message` open, and names the skill `handoff_slack`. In a routine they add a step that invokes `handoff_slack`; the routine has one path for success and one for failure.

**Why this priority**: This is the whole capability end-to-end with the simplest auth. It proves the generic spine — connection → discovery → named binding → routine invocation → react to outcome — and is demoable on its own. Everything else refines it.

**Independent Test**: Against a mock MCP server fixture, define one connection + one skill binding a tool with one bound and one exposed param, reference it in a routine, and verify the routine calls the tool with merged params and takes the success path on success and the failure path on a tool error — with no provider-specific code in the product.

**Acceptance Scenarios**:

1. **Given** a reachable MCP connection, **When** the author opens the skill builder and selects the connection, **Then** the server's available tools are listed (discovered live), each showing its input fields.
2. **Given** a selected tool, **When** the author pre-sets some inputs and leaves others exposed and names the skill, **Then** the skill definition is saved and becomes selectable when authoring a routine.
3. **Given** a routine step that references a defined skill, **When** the routine reaches that step, **Then** the system calls the bound tool with the bound params plus the conversation-supplied exposed params and waits for the result.
4. **Given** the tool returns a successful result, **When** the step completes, **Then** the routine follows its success transition.
5. **Given** the tool returns an error (or the call fails), **When** the step completes, **Then** the routine follows its failure transition and the conversation degrades safely.
6. **Given** a routine references a defined skill, **When** the turn runs, **Then** the conversation engine and routine runner remain unaware of MCP internals (the skill is invoked through the same port retrieval uses).

---

### User Story 2 - OAuth-authenticated connections (Priority: P2)

An author connects an external MCP server that requires OAuth (the model used by hosted vendor MCP servers). The author completes a one-time authorization for the connection; thereafter skills on that connection call the server using stored, automatically-refreshed credentials.

**Why this priority**: Most hosted vendor MCP servers require OAuth, so this unlocks real-world integrations beyond static-token/dev servers. It is additive to US1 — the same connection/skill/routine model, a richer auth method.

**Independent Test**: Configure a connection whose auth method is OAuth against a mock authorization server; complete the consent step once; verify a skill on that connection can call a tool using the stored token and that an expired token is transparently refreshed before the call.

**Acceptance Scenarios**:

1. **Given** a connection configured for OAuth, **When** the author starts authorization, **Then** they are guided through a one-time consent flow and the connection becomes "authorized".
2. **Given** an authorized OAuth connection, **When** a routine invokes a skill on it, **Then** the call succeeds using the stored credential without re-prompting the author.
3. **Given** a stored credential has expired, **When** a skill is invoked, **Then** the credential is refreshed automatically and the call proceeds; if refresh fails, the connection is flagged as needing re-authorization and the routine takes its failure path.

---

### User Story 3 - Meaning-based outcome branching (Priority: P3)

An author wants a routine to react differently to distinct *meanings* of a tool result, not just success vs failure — e.g. "the requested slot was already taken" vs "no availability at all" vs "booked". The author can branch a routine on named outcomes derived from the tool result.

**Why this priority**: Coarse success/failure (US1) is enough for many skills; meaning-based branching is the richer "react to the outcome" experience but is only needed for some tools, so it layers on last.

**Independent Test**: With a mock tool that returns distinguishable result payloads, define a skill whose outcomes include a custom status, author a routine that branches on it, and verify each distinct result drives the matching branch — using a language-neutral classification (not keyword matching), so it works regardless of the conversation language.

**Acceptance Scenarios**:

1. **Given** a skill whose tool can return distinct result meanings, **When** the author defines the skill, **Then** they can declare the named outcomes the routine may branch on.
2. **Given** a routine with branches per named outcome, **When** the tool returns a given result, **Then** the routine follows the branch matching the derived outcome.
3. **Given** the conversation is in a non-English language, **When** outcomes are derived, **Then** classification still works (no hard-coded English keyword lists).

---

### Edge Cases

- **Connection unreachable / timeout**: the invocation resolves as a failure outcome within a bounded time; the routine takes its failure path; the operator can see the failure.
- **Auth invalid/expired (no refresh)**: connection flagged as needing attention; routine takes failure path; no secret leaks into errors or logs.
- **Discovery drift**: a tool a skill is bound to no longer exists on the server → the skill is reported invalid at author time and fails safely at runtime.
- **Exposed param cannot be filled** from the conversation → the step does not call the tool with an invalid payload; it asks for the missing input or fails safely per the routine.
- **Malformed/oversized tool result** → treated as a failure outcome; bounded handling; no crash.
- **Skill's connection deleted** while referenced by a routine → the routine reference is reported invalid; runtime fails safely.
- **Same tool bound by multiple skills** (different presets) → each resolves independently to its own binding.
- **Author attempts to expose a connection's raw tools directly to the model** → not possible; only authored, named skills are invocable.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js; frontend (skill builder, routine picker) MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` available (this feature adds relational tables only).
- The default LLM provider governs any model-assisted step (US3 outcome classification); no second provider is introduced.
- Any user-facing assistant/chat copy produced around these steps MUST be LLM-generated, not hard-coded application strings, so multilingual behavior is preserved. US3 outcome classification MUST be language-neutral (no English keyword lists).
- Backend development MUST follow TDD: failing tests first (mock MCP server fixture, executor, resolver, repositories), then implementation.
- Frontend user-visible behavior (skill builder, routine picker) MUST prefer Playwright; unit tests stay on non-visual logic (schema→form derivation, param merge, API adapters).
- Secrets (access tokens, OAuth client secrets/refresh tokens) MUST be stored encrypted and MUST NOT be committed; `.env.example` MUST be updated for any new operator configuration (e.g. encryption key reuse). Tokens MUST NOT be stored in non-secret per-agent settings.
- Customer data MUST be protected with least-privilege: a routine may invoke only authored, param-bound skills; external calls carry only the bound + conversation-supplied params.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence (see Architecture Constraints).
- The conversation engine/contract packages and chat route handlers MUST remain MCP-agnostic and orchestration-only.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - *Capability port (orchestration-neutral)*: external skills are invoked through the **existing `SkillExecutorPort`**, exactly as retrieval is (`RetrievalAnswerSkillExecutor` is the template). The conversation engine, routine runner, and turn loop MUST NOT gain MCP knowledge.
  - *Transport*: a new SDK-backed `ToolService` (MCP client) owns protocol/transport/auth; nothing above the `ToolService` port knows it is MCP.
  - *Domain*: the **name→binding resolver** (skill definition → connection + tool + bound/exposed params + param merge) and outcome derivation are domain logic in `backend/src/modules/`.
  - *Persistence*: MCP connections and skill definitions live in their own repositories; secrets in the existing encrypted secret store.
  - *Composition*: default wiring (registering the MCP skill executor, building the `ToolService`, the resolver, repositories) belongs in `backend/src/app/composition/`.
- **Encapsulation Rule**:
  - Reuse `packages/conversation-tools` `ToolSkillBridge` **unchanged** (it is transport-agnostic). Replace only the transport behind the `ToolService` (the bundled HTTP-JSON-RPC `mcpAdapter.ts` lacks Streamable HTTP/OAuth and MUST NOT be the runtime client).
  - `packages/conversation-contract` / `packages/conversation-engine` stay MCP-free.
  - Chat route handlers and the routine runner stay orchestration-only.
  - Non-secret skill/connection config MAY live in per-agent settings; secrets MUST live only in the encrypted secret store.
- **New Seams Required**:
  - SDK-backed `ToolService` over the official MCP client (Streamable HTTP + OAuth).
  - MCP **connection** repository/service (server address, auth method, encrypted credentials, status).
  - Skill **definition** repository/registry + **resolver** (name → connection/tool/param binding).
  - Generic MCP **skill executor** behind `SkillExecutorPort` (mirrors retrieval; adds the name→binding resolver + param merge + outcome mapping).
  - Outcome **interpretation** port (US3): default model-assisted classifier (prompt asset) + optional declarative per-skill map.
  - Skill-builder + routine-picker API + UI.
- **Anti-Goals**:
  - Do NOT expose raw discovered tools to the model or let the model choose the connection/tool — only authored, named skills are invocable (the set of skill definitions IS the allow-list).
  - Do NOT add MCP logic to the chat route handler, conversation engine, or routine runner.
  - Do NOT store tokens in per-agent `skillSettings` or any non-secret/plaintext location.
  - Do NOT encode outcome meaning with English keyword/verb lists; use language-neutral classification or structured result fields.
  - Do NOT hardcode any provider (Slack/Cal.com) connection or tool in product code; they are data.
  - Do NOT hand-edit `backend/openapi.yaml` / `backend/openapi.json` (regenerate from the code-first registry).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Authors MUST be able to create, view, update, and delete a reusable **MCP connection** (server address + auth method + credentials + status), scoped per the Assumptions below.
- **FR-002**: The system MUST discover a connection's available tools live (and each tool's input fields/schema) for use during authoring.
- **FR-003**: Authors MUST be able to create, view, update, and delete a **skill definition** that binds exactly one discovered tool of one connection, with a unique author-given name.
- **FR-004**: For the bound tool's inputs, authors MUST be able to mark each input as **bound** (preset to a fixed value) or **exposed** (filled from the conversation at run time).
- **FR-005**: Authors MUST be able to reference a defined skill by name within a routine step (the routine-authoring picker lists available skills).
- **FR-006**: At run time the system MUST invoke a referenced skill through the same skill port retrieval uses; the conversation engine/routine runner MUST remain unaware of MCP.
- **FR-007**: On invocation the system MUST merge bound params with conversation-supplied exposed params and call the bound tool; exposed params are filled from conversation context against the tool's input schema (default), with optional author binding of an exposed param to a named routine slot.
- **FR-008**: The system MUST map a tool result to a routine-branchable outcome: at minimum a coarse success vs failure (P1); meaning-based named outcomes (P3) MUST be derivable via language-neutral classification and/or an optional declarative per-skill map.
- **FR-009**: Routines MUST be able to branch on the derived outcome using existing routine transition mechanics.
- **FR-010**: Connections MUST support a static access-token/bearer auth method (P1) and an OAuth authorization-code method with stored, auto-refreshed credentials (P2); refresh failure MUST flag the connection as needing re-authorization.
- **FR-011**: All external-call credentials MUST be stored encrypted; credentials, payloads, and tokens MUST NOT appear in logs, traces, or error messages surfaced to users.
- **FR-012**: Only authored skill definitions MAY be invoked by routines; the model MUST NOT be able to select an arbitrary connection or tool from user input.
- **FR-013**: External tool invocations MUST be bounded (timeout) and MUST fail safely into the routine's failure outcome when the connection is unreachable, unauthorized, slow, or returns an error/malformed result.
- **FR-014**: The system MUST validate a skill definition against current discovery (bound tool still exists; bound params valid) and report invalid skills at author time and fail safely at run time.
- **FR-015**: Connection and skill-definition configuration MUST be representable as data consistent with the "agent settings as data" direction (exportable/importable), excluding secrets which are handled by the secret store.
- **FR-016**: External tool invocations MUST emit observability: a span/metric capturing connection/server identity, tool name, derived outcome status, and latency — WITHOUT payloads, PII, tokens, or full results.
- **FR-017**: Adding a new external integration (a new connection + skill definitions) MUST require no code change and no deploy.

### UI Tasks

- **Connections screen**: list/create/edit/delete MCP connections; choose auth method (access token | OAuth); for OAuth, a one-time "Authorize" action and an authorization status indicator; uses the shared dark theme.
- **Skill builder**: select a connection → see discovered tools → select one → schema-driven form listing each input with a bind/expose toggle and a value field for bound inputs → name the skill → save. Shows validation when a binding is invalid.
- **Routine authoring picker**: when adding/editing a routine step, list defined skills to reference by name (the `@mention`), and surface the skill's named outcomes as branchable transitions.
- All user-visible behavior covered by Playwright; non-visual logic (schema→form derivation, bind/expose state, param merge preview) may have focused unit tests.

### Key Entities

- **MCP Connection**: a reusable pointer to an external MCP server. Attributes: display name, server address, auth method (access-token | OAuth), encrypted credentials (token, or OAuth client + tokens), authorization status, owner scope. Relationships: has many Skill Definitions.
- **Skill Definition**: a named binding of one discovered tool. Attributes: unique skill name (the routine `@mention`), connection reference, tool name, bound params (fixed values), exposed params (conversation-filled, optional slot binding), optional declared named outcomes / outcome map, enabled flag, owner scope. Referenced by routine steps by name.
- **Discovered Tool** *(transient, not persisted)*: a tool surfaced by live discovery — name, description, input schema — used during authoring and validation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An author can connect an external MCP server, define a named skill bound to one of its tools, and use it in a routine **without any code change or deployment**.
- **SC-002**: A routine using an external skill follows the correct path for at least the two coarse outcomes (success, failure) in 100% of test cases against the mock server fixture.
- **SC-003**: Adding a **second** external integration after the first requires **zero new product code** (only new data/configuration).
- **SC-004**: For a defined skill, an author can complete the build flow (select connection → select tool → bind/expose params → name → save) in under 3 minutes for a typical few-parameter tool.
- **SC-005**: When an external tool is unreachable, unauthorized, or errors, the routine degrades to its failure path within the configured bound (e.g. ≤ 10 seconds) in 100% of failure tests, with no secret exposed.
- **SC-006**: No component above the skill port (conversation engine, routine runner, chat route) references MCP — verifiable by inspection and dependency boundaries.
- **SC-007**: For meaning-based outcomes (US3), routines select the correct branch for distinct result meanings in a non-English conversation in test cases (language-neutral classification).

## Assumptions

- **Scoping**: MCP connections and skill definitions are **per-agent** for this feature (consistent with per-agent `skillSettings` and per-agent routine ownership). Workspace-level sharing of connections is a possible later enhancement and is out of scope here.
- **Auth slicing**: P1 ships static access-token/bearer auth (sufficient to prove the generic spine and many dev/self-hosted servers); OAuth (P2) is specified here but independently deliverable.
- **Outcome slicing**: P1 ships coarse success/failure; meaning-based named outcomes (P3) layer on without changing the P1 contract.
- **Transport**: remote Streamable-HTTP MCP servers are the supported target; stdio/subprocess servers are out of scope for this feature.
- **Encryption**: reuse the existing field-encryption mechanism and operator-provided encryption key; no new crypto.

## Cross-Cutting Reviews *(mandatory per constitution)*

- **Code-First API Contracts (VIII)**: New backend routes (connection CRUD, discovery, skill-definition CRUD, OAuth authorize/callback) MUST be defined in the code-first OpenAPI registry with Zod schemas; `backend/openapi.yaml`/`.json` MUST be regenerated (not hand-edited) and contract tests aligned.
- **Message-Queue Impact Review**: This feature adds **synchronous, in-turn** external calls behind the skill port; it does **not** introduce new worker/AMQP payloads or change document-worker dispatch or retry semantics. If planning discovers any queue involvement, queue payloads/tests/docs MUST be updated. Default expectation: no queue changes.
- **Documentation Parity (IX)**: Update routine/skills documentation and add an operator-facing **MCP connections** settings doc (connecting a server, auth methods, defining skills, using them in routines, security model). Read `docs/document-writer-prompt.md` before editing docs.
- **Prompt Asset Ownership (X)**: The US3 outcome-classification prompt asset MUST live under `backend/prompts/`.
- **Secrets/Config (IV)**: Update `.env.example` if any new operator configuration is required; never commit secrets.
