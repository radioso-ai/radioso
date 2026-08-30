# Feature Specification: In-Product Operator Copilot

**Feature Branch**: `in-product-ai-agent-tab`
**Created**: 2026-07-18
**Status**: Approved (requestor approved in session 2026-08-11 after two Codex
review rounds, a manual findings pass, and the breadth-strategy revision (D7);
open-clarification defaults O1–O3 accepted as decisions — see Resolved
Decisions and Open Clarifications)
**Input**: User description: "A goal of Radioso is to give an AI agent tab similar to PostHog AI, which would allow the user to create/edit/troubleshoot Radioso agents, explain conversations, give recommendations etc. This can currently work by giving Claude/Codex/Gemini the source code and the API token to a workspace, but this is both expensive and doesn't replicate the experience I am aiming at (in-product agent)."

## Context

Operators today troubleshoot their Radioso agents by pasting a workspace API token
(and often the product source code) into an external coding agent. That workflow is
expensive (the external agent reads far more than it needs), insecure (a
god-credential leaves the product), and not the product experience Radioso wants:
the platform that sells conversational agents should have one in its own dashboard.

The substrate for an in-product agent already exists and is deliberately
product-neutral:

1. **Agent runtime** — `backend/src/shared/agent-runtime/` hosts a typed
   tool-calling loop (`AgentRuntime`, `AgenticCapabilityRunner`,
   `TextRoutedToolCallingGateway`) with Zod tool contracts, budgets, cancellation,
   and a streaming trace-event model. Its only consumer today is agentic retrieval
   (`backend/src/modules/retrieval/services/agenticTools/`), which is the
   implementation template for new tool sets.
2. **Control-plane services** — agents, directives, routines, skills, documents,
   settings, history/traces, evals, decisions, and quality signals all have
   authed services behind `/api/v1`, each guarded by its own area permission
   (`workspace.agents.read`/`manage`, `workspace.history.read`,
   `workspace.documents.read`, `workspace.quality.read`,
   `workspace.settings.read`, `workspace.retrieval.query`, …) via
   `requireWorkspacePermission`.
3. **Single-purpose operator assistants** — the platform already ships three
   bespoke LLM assists for operators: the agent wizard
   (`backend/src/modules/agentWizard/`, website parsing → agent config), the
   directive coach (`directiveAuthorService.ts`, coaching → directive draft),
   and Audience Pulse (`backend/src/modules/audiencePulse/`, the periodic
   census/summary of visitor questions from spec 939/956). Each is a fixed
   pipeline with its own module, prompt, and composition wiring — the pattern
   is sound, but none is conversational, and each new one has been a bespoke
   surface.
4. **Dashboard chat plumbing** — SSE streaming conventions
   (`chatPresenter.sendChatSse`, `frontend/lib/api-chat-stream.ts`) and workbench
   chat components.

What is missing is the connective tissue: a control-plane **tool catalog** (no
`AgentTool` exists for "read this conversation's trace" or "draft a directive"), a
**copilot surface** that mounts the runtime under a dashboard session principal,
and a **proposal mechanism** so the copilot can suggest configuration changes
without writing anything itself.

Positioning decisions already made (recorded here so planning does not relitigate
them):

- **The copilot is OSS.** The EE line today gates hosted-business concerns (auth,
  tiers, staff console), not product capability, and the tool catalog must remain
  OSS because it doubles as the future MCP admin scope ("Scope 2" left open by
  spec 098-mcp-agent-converse). EE participates through three levers: managed
  model access on cloud, EE-registered additional tools via the composition seam,
  and copilot usage limits through the existing tier-enforcement system.
- **The copilot is not an authored agent.** It does not use the conversation
  engine, directives, routines, or the `agent_skills` spine — those model
  customer-facing agents an operator authors. The copilot is a fixed product
  surface built directly on the agent runtime. The earlier "no whole-turn
  agent" decision applies to the customer turn spine, not to this surface.
- **Tools are curated per family, contributed per module, and coverage-checked —
  never schema-generated.** Breadth comes from generic family readers (one
  agent-configuration reader over the `AgentConfig` projection, one trace
  reader, one history search, one document search, …) rather than per-feature
  tools — so a feature that follows the platform's own "agent settings are
  agent data" rule (spec 079) is copilot-readable with no catalog change. Each
  owning module contributes its own descriptors, shipping a descriptor (or an
  explicit exclusion) is part of an operator-facing feature's definition of
  done, and a repo check derived from the OpenAPI registry reports
  control-plane operations unreachable by any tool — a forgotten feature is a
  red check, not a silent gap. Individual tools are never auto-generated from
  the OpenAPI registry: each has a tuned description, focused input/output
  schemas, and an explicit permission requirement. (This mirrors how PostHog's
  Max gets breadth: every tool hand-written, generic readers per family,
  per-product auto-discovered contribution — no API-derived tools.)
- **Existing single-purpose assistants fold in as catalog tools; they are the
  pattern, not parallel surfaces.** The agent wizard and directive coach become
  proposal-drafting tools, and Audience Pulse results become a read tool — each
  module keeps owning its analysis/drafting logic and contributes a tool
  descriptor. Going forward this is the default for operator-assist features:
  ship a catalog tool through the contribution port, not a new bespoke
  assistant surface, unless the feature genuinely needs its own non-chat UI (as
  Audience Pulse's dashboard view does — the view stays; the copilot gains
  access to the same results).
- **Mutations are proposals.** The copilot never writes configuration. Mutation
  tools produce typed proposals rendered as reviewable cards; the write happens
  only when the operator applies the proposal through the existing guarded
  services.
- **Models and credentials come from the existing workspace LLM capability
  resolution.** Workspace-configured keys and model preferences apply when
  present and override environment defaults, exactly as for the customer-facing
  surfaces; there is no copilot-only provider integration.
- **The copilot is a session-only surface.** `requireWorkspaceSession` also
  accepts workspace API bearer tokens; the copilot must not. Copilot routes
  reject bearer-authenticated callers before any turn or tool executes — the
  whole point is retiring the pasted-token workflow, and copilot conversations
  belong to an operator account, which a bearer principal does not identify.

Out of scope for this feature (follow-ups, not requirements): exposing the
catalog over MCP as the admin scope, frontend-mounted contextual tools
(PostHog `MaxTool`-style page-bound tools), per-workspace copilot long-term
memory, disconnect/resume of in-flight runs via a broker, a copilot eval suite in
CI, and EE managed model credits.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Explain and troubleshoot a conversation (Priority: P1)

An operator opens the copilot tab in the dashboard and asks, in their own words,
why an agent behaved a certain way — "why did the agent refuse to answer in this
conversation?", "why did it not use the pricing document?". The copilot, aware of
which agent or conversation the operator is currently viewing, fetches the actual
transcript, turn traces, and agent configuration through its tools, and streams
back an explanation grounded in that data, citing the concrete stages (directive
matched, retrieval results, routine step, clarification) that produced the
behavior.

**Why this priority**: This is the workflow the external-LLM-plus-API-token hack
exists to serve, and it is read-only, so it delivers the core value with the
smallest trust surface. Everything else layers on this loop.

**Independent Test**: Seed a workspace with an agent and a conversation whose
trace contains a known cause (e.g. a directive suppressed retrieval). Ask the
copilot why the agent answered as it did, and verify the explanation streams,
names the actual cause from the trace, and that every factual claim about the
conversation is traceable to a tool result rather than invented.

**Acceptance Scenarios**:

1. **Given** an operator with a valid dashboard session viewing a conversation,
   **When** they ask the copilot to explain the agent's behavior in it, **Then**
   the copilot resolves "this conversation" from the page context without the
   operator pasting IDs, reads the transcript and turn trace via tools, and
   streams an explanation that references the actual trace stages.
2. **Given** a copilot turn in progress, **When** tools execute, **Then** the
   operator sees live status of the copilot's activity (which capability is
   running, at what stage) before the final answer arrives.
3. **Given** a question the copilot's tools cannot answer (missing conversation,
   no trace retained), **When** the copilot responds, **Then** it states what it
   could not access rather than fabricating an account, and the failed tool call
   is visible in the turn's activity.
4. **Given** a completed copilot conversation, **When** the operator returns to
   the copilot tab later, **Then** the conversation history is preserved and can
   be continued, and it does not appear in the customer-facing Activity or
   quality views.
5. **Given** an operator whose session lacks read permission on agents, **When**
   they open the copilot, **Then** the surface is unavailable rather than
   degraded, and no tool executes.
6. **Given** a caller authenticated with a workspace API bearer token instead of
   a dashboard session, **When** they call any copilot endpoint, **Then** the
   request is rejected before any turn starts or tool executes.

---

### User Story 2 - Configuration guidance and recommendations (Priority: P2)

An operator asks the copilot how to change their agent's behavior — "how do I
stop it from recommending competitors?", "why does this routine never trigger?",
"which documents are stale?". The copilot inspects the agent's directives,
routines, skills, settings, document corpus, and recent quality signals, and
answers with specific, named recommendations ("directive X already excludes Y;
add …", "routine Z's trigger overlaps with …") rather than generic advice.

**Why this priority**: Turns the copilot from an incident explainer into an
ongoing advisor. Still read-only, so it composes entirely from US1's
infrastructure plus additional read tools.

**Independent Test**: On a workspace with a known configuration flaw (e.g. two
directives with overlapping triggers), ask the copilot why behavior is
inconsistent and verify the answer names the actual conflicting directives and
proposes a concrete, applicable change.

**Acceptance Scenarios**:

1. **Given** an agent with directives, routines, and skill settings, **When** the
   operator asks a "how do I make it do X" question, **Then** the copilot's
   recommendation references the actual configuration entities by name and states
   what to change, not generic product documentation.
2. **Given** a workspace with eval runs and quality signals, **When** the operator
   asks what needs attention, **Then** the copilot summarizes from the real eval
   results and quality data via tools.
3. **Given** a question about Radioso itself that tools cannot answer ("what does
   the similarity threshold do?"), **When** the copilot responds, **Then** it may
   answer from general knowledge but distinguishes product guidance from claims
   about this workspace's data.

---

### User Story 3 - Proposal-card mutations (Priority: P3)

The operator accepts a recommendation and says "do it". The copilot produces a
proposal — a new directive, an edit to an existing directive, an agent setting
change (the D5 target set; routine and document proposals are deferred) —
rendered in the chat as a card showing exactly what would change (new content, or a diff against
current state). The operator applies or dismisses the card. Applying performs the
write through the same guarded services the dashboard forms use; the copilot
itself never mutates configuration.

**Why this priority**: Completes the create/edit half of the vision, but it must
sit on the trust and correctness track record established by US1/US2, and it
requires the proposal entity and card UI that nothing else needs.

**Independent Test**: Ask the copilot to draft a directive from a described
behavior, verify a proposal card renders with the draft content, apply it, and
verify the directive exists on the agent exactly as previewed — and that
dismissing an equivalent card writes nothing.

**Acceptance Scenarios**:

1. **Given** a copilot recommendation the operator accepts, **When** the copilot
   drafts the change, **Then** a proposal card shows the full proposed content
   (and a diff where it modifies an existing entity) before anything is written.
2. **Given** a rendered proposal card, **When** the operator applies it, **Then**
   the write goes through the existing management service with the operator's
   session permissions (`agentManage`), the card reflects the applied state, and
   the created/updated entity is identical to the preview.
3. **Given** a proposal card, **When** the operator dismisses it or never acts,
   **Then** no configuration changes, and the proposal's state records the
   outcome.
4. **Given** a proposal whose target changed since drafting (e.g. the directive
   was edited meanwhile), **When** the operator applies it, **Then** the
   application fails safely with a stale-proposal outcome instead of silently
   overwriting the newer state.
5. **Given** an operator with read-only permissions, **When** the copilot would
   draft a mutation, **Then** proposal tools are not available to the copilot for
   that principal, and the copilot says the operator lacks permission rather than
   producing an unappliable card.

---

### Edge Cases

- No LLM capability resolves for the workspace (neither workspace-configured
  keys nor environment defaults): the copilot tab renders a non-conversational
  setup state (UI copy, not assistant copy) pointing to settings; no turn can
  start. Workspace keys merely being absent is not this state when environment
  defaults resolve.
- The runtime exhausts its step/token/wall-time budget mid-turn: the turn ends
  with a visible "budget exhausted" outcome and a partial-findings answer, not a
  hang or a silent truncation presented as complete.
- A tool fails (service error, deleted entity): the loop continues where
  possible; the failure is visible in the turn activity and reflected honestly in
  the answer.
- Customer conversation content read through tools is untrusted end-user text and
  may contain prompt-injection attempts; the copilot treats tool output as data,
  and the proposal-approval gate means injected instructions cannot mutate
  configuration without an operator's explicit apply.
- Two copilot turns started concurrently in the same copilot conversation: the
  second is rejected or queued; state never interleaves.
- The operator navigates away mid-stream: the turn completes and persists
  server-side; reopening the copilot shows the finished turn (resume of the live
  stream is out of scope).
- Very long copilot conversations: history included in the model context is
  bounded; the conversation remains usable past the bound.
- Trace retention has expired for an old conversation: the copilot reports the
  data gap instead of reconstructing from memory.

## Resolved Decisions and Open Clarifications

Decisions resolved during drafting and review (planning must not relitigate):

- **D1 — Session-only auth.** Copilot endpoints reject bearer-authenticated
  principals (`authMode === "bearer"`); only dashboard session principals may
  start turns or apply proposals.
- **D2 — Per-family permission matrix.** Tools carry the permission of the area
  they read (see FR-006 matrix); the copilot surface itself requires
  `workspace.agents.read`, and a principal missing a family's permission simply
  has those tools absent from its catalog.
- **D3 — Metering semantics.** One `UsageLimitPolicy.reserveAnswer` reservation
  per copilot turn with a copilot-specific `surface` value, reserved at turn
  start, committed on a persisted terminal outcome, released when the turn
  produces nothing billable. Individual model steps within a turn are not
  separately metered; token usage is recorded through existing usage events.
- **D4 — Copilot SSE event contract.** The copilot defines its own SSE event
  vocabulary (see FR-004) mapped from agent-runtime trace events; it reuses the
  transport conventions (SSE framing, frontend stream parsing), not the chat
  presenter's event set.
- **D5 — Initial proposal targets.** P3 ships directive proposals
  (create/update, drafted via the existing `DirectiveAuthorService`) and
  per-agent setting-change proposals (payload composed by the copilot, validated
  by existing schemas). Routine and document proposals are deferred until their
  owning modules expose drafting services.
- **D6 — Staleness via per-target adapters.** Each proposal target type provides
  an adapter (read current version token, preview diff, apply-if-version-matches);
  there is no generic cross-entity staleness hash.
- **D7 — Breadth strategy.** Catalog breadth comes from family-level readers,
  per-module contribution as definition of done, and an OpenAPI-derived
  coverage check — not from schema-generated tools (PostHog Max precedent:
  all tools hand-written; breadth via generic readers and auto-discovered
  per-product contribution).
- **D8 — Knowledge-base remediation acts (#1049).** The approved catalog
  extension adds a paged `document_chunks` reader plus `reprocess_document`
  and `recrawl_source` acts. Reprocessing existing persisted content and
  recrawling one already-configured website source are idempotent,
  operator-visible maintenance operations; they do not change authored agent
  behavior and therefore do not create proposal cards. Creating a new source,
  whole-workspace reprocessing, and embedding-model changes remain outside
  this slice.
- **D9 — Agent-scoped retrieval probes (#1051).** Retrieval probes attributed
  to an agent must resolve that agent's effective retrieval settings. The
  target design is optional `agentId` scoping on the public retrieval endpoints
  (with answer evidence retaining chunk scores); until that contract ships,
  Ray must use the real agent pipeline through `test_agent_turn` or
  `replay_eval_case` and must not expose the workspace-default probe endpoints
  as if they measured an agent.

Open clarifications (non-blocking; default answers stated):

- **O1 — Copilot turn limits in OSS.** Default: unmetered in OSS (policy no-op),
  metered only where EE tier enforcement is active.
- **O2 — Retention of copilot conversations.** Default: retained until deleted
  by the operator; no automatic expiry in this feature.
- **O3 — Constitution model default vs code default.** The constitution names
  GPT-5.2; `providerConfig.ts` defaults to `gpt-5.4-mini`. This feature takes
  no dependency on the specific value (it uses the shared resolution seam
  exclusively), so the reconciliation — a constitution amendment or a
  code-default change — is separate housekeeping, not a blocker for this spec.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use the platform's default provider policy. For this
  feature that requirement is made precise and reviewable as: the copilot MUST
  NOT introduce any provider integration, hard-coded model, or default of its
  own — every model call resolves provider and model exclusively through the
  existing shared resolution seam (`providerConfig.ts` defaults, workspace
  preferences overriding). The constitution names GPT-5.2 as the default while
  the code's current default is `gpt-5.4-mini`; that pre-existing divergence is
  tracked as open clarification O3 and its resolution (a constitution
  amendment or a code-default change) alters nothing in this feature, which is
  conformant under either value by construction.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: A new OSS module `backend/src/modules/operatorCopilot/` owns
  the copilot transport (routes/SSE presentation), copilot conversation and
  proposal persistence, catalog assembly, and runtime invocation. It consumes
  other modules only through their public ports and the shared agent runtime; it
  owns no product domain logic of other modules.
- **Encapsulation Rule**: `backend/src/shared/agent-runtime/` stays
  product-neutral — it must gain no knowledge of the copilot, tools, or
  workspaces. The conversation engine, `agent_skills` spine, and customer
  conversation/message tables are not touched by this feature. The agent wizard,
  directive coach, and Audience Pulse modules remain the owners of their
  drafting/analysis logic; the copilot wraps them as tools rather than
  duplicating their prompts, and Audience Pulse's own dashboard view is
  untouched.
- **New Seams Required**:
  - A **copilot tool contribution port**: a typed descriptor (name, description,
    Zod input/output schemas, required permission, contributing module) that
    owning modules export from their public surface and
    `backend/src/app/composition/` assembles into the catalog. This port must be
    designed for three consumers from day one: the copilot runtime, EE package
    registration (additional tools), and a future MCP admin scope exposing the
    same catalog.
  - A **proposal contract with per-target adapters**: a typed proposal (target
    entity reference or "new entity", proposed payload, version token, status)
    that mutation-drafting tools emit and the apply endpoint consumes. Each
    supported target type contributes an adapter exposing read-current-version,
    preview-diff, and apply-if-version-matches; the copilot module never
    computes staleness or diffs from raw entity shapes itself.
  - A **copilot page-context contract**: the small structure the dashboard sends
    with each turn describing what the operator is viewing (agent, conversation,
    view), validated on the backend and injected as context, never as
    instructions.
  - A **catalog coverage check**: a repository check (sibling of
    `validate-architecture-boundaries.mjs`) that derives the control-plane
    operation list from the OpenAPI registry and fails when an operation is
    neither reachable through a catalog tool nor explicitly allowlisted as out
    of catalog scope with a stated reason.
- **Anti-Goals**:
  - Do not auto-generate tools from the OpenAPI registry — derive the coverage
    check from it instead.
  - Do not give the copilot direct repository/database access; every read and
    write goes through the owning module's service with permission checks.
  - Do not store copilot conversations in the customer conversation tables or let
    them surface in Activity, quality, decisions, or history APIs.
  - Do not let any mutation happen inside the tool loop; writes occur only in
    the operator-initiated apply path.
  - Do not import EE code; EE extends the catalog only through the established
    registration seam.
  - Do not hard-code English intent/keyword matching anywhere in the copilot;
    tool selection is the model's, and any classification is prompt-returned
    enums.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard MUST offer a copilot surface (tab/panel) available on
  every workspace to operators whose session holds `workspace.agents.read`.
  Copilot endpoints MUST accept only dashboard session principals and MUST
  reject workspace API bearer tokens before any turn or tool executes.
- **FR-002**: The copilot MUST run as a tool-calling loop on the shared agent
  runtime under the operator's session principal, resolving models and
  credentials through the existing workspace LLM capability resolution
  (workspace keys and preferences override environment defaults).
- **FR-003**: Each copilot turn MUST enforce runtime budgets (steps, tokens,
  wall time) with a defined, operator-visible outcome on exhaustion.
- **FR-004**: The copilot MUST stream responses over SSE using the existing
  transport conventions (framing, frontend stream parsing) with a
  copilot-specific event contract — at minimum: conversation identity, answer
  text chunks, tool activity started/completed/failed (UI-safe capability label
  and stage, never raw tool payloads), turn outcome (completed, budget
  exhausted, failed), and a distinct terminal event — defined as a typed mapping
  from agent-runtime trace events, not as a reuse of the customer chat
  presenter's event set.
- **FR-005**: The initial tool catalog MUST cover, as read-only tools: agent
  configuration (agent, directives, routines, skills and their settings),
  conversation transcripts and turn traces, document corpus search and document
  metadata, eval results, quality/needs-attention signals, and Audience Pulse
  topic-census results (the existing periodic visitor-question summary, exposed
  as a read tool over its stored analyses — the copilot does not trigger new
  analyses). These MUST be structured as family-level readers, not per-feature
  tools: agent-configuration reads go through the `AgentConfig` projection (so
  new agent-data fields are covered without catalog changes), routine reads
  return the portable markdown form, and conversation reads return the existing
  trace envelope.
- **FR-006**: Every tool MUST declare a required permission, and the catalog
  presented to a turn MUST include only tools whose permission the session
  principal holds. The initial matrix, following the owning areas' existing
  guards:

  | Tool family | Required permission |
  |---|---|
  | Agent configuration (agent, directives, routines, skills, skill settings) | `workspace.agents.read` |
  | Conversation transcripts and turn traces | `workspace.history.read` |
  | Document search and document metadata | `workspace.documents.read` |
  | Eval results | `workspace.retrieval.query` |
  | Quality / needs-attention signals, Audience Pulse census results | `workspace.quality.read` |
  | Workspace settings reads | `workspace.settings.read` |
  | Proposal drafting and apply (directives, agent settings) | `workspace.agents.manage` |

  Exact permission identifiers follow the existing permission registry; a tool
  never requires a weaker permission than the service it wraps.
- **FR-007**: All tool reads and the proposal apply path MUST be scoped to the
  authenticated workspace; no tool may accept a foreign workspace identifier.
- **FR-008**: Copilot conversations and messages MUST persist in
  copilot-owned storage, MUST be listable/resumable/deletable by the operator,
  and MUST NOT appear in customer-facing history, Activity, quality, or decision
  surfaces.
- **FR-009**: The dashboard MUST send page context (current agent, conversation,
  view) with each turn, and the copilot MUST use it to resolve deictic references
  ("this conversation") without the operator supplying identifiers.
- **FR-010**: Mutation-capable tools MUST emit proposals; the system MUST NOT
  perform any configuration write during a copilot turn.
- **FR-011**: Proposals MUST render as cards showing the full proposed content,
  and a diff against current state when modifying an existing entity, before any
  apply.
- **FR-012**: Applying a proposal MUST execute through the existing management
  services under `workspace.agents.manage`, MUST use the target type's proposal
  adapter to apply only when the target's current version matches the
  proposal's version token (failing safely with a stale outcome otherwise), and
  MUST record the proposal outcome (applied, dismissed, failed, stale).
- **FR-013**: The initial proposal targets are directives (create and update,
  drafted through the existing directive coach service) and per-agent setting
  changes (payload composed by the copilot and validated by the existing
  settings schemas — no new drafting prompt). Routine and document proposals
  are out of scope until their owning modules expose drafting services; the
  copilot MUST NOT duplicate or fork existing drafting prompts.
- **FR-014**: Copilot prompt templates MUST live under `backend/prompts/` and
  copilot conversational copy MUST come from the LLM, including error and
  data-gap explanations within a turn.
- **FR-015**: The tool contribution port MUST allow EE packages to register
  additional tools through the existing composition/registration seam without
  the OSS module referencing EE.
- **FR-016**: Each copilot turn MUST make exactly one
  `UsageLimitPolicy.reserveAnswer` reservation at turn start with a
  copilot-specific `surface` value, committed only when a terminal outcome is
  persisted and released when the turn fails before producing one. Individual
  model steps within a turn are not separately metered; OSS behavior defaults
  to unmetered (policy no-op), and EE tier enforcement meters through this same
  seam.
- **FR-017**: The copilot MUST emit observability for each turn — turn started/
  completed/failed with duration, per-tool invocation counts and failures, budget
  exhaustions, and proposal outcomes — without logging raw prompts, completions,
  transcript content, or credentials. Copilot operator actions (turn started,
  proposal applied) MUST be recorded as raw audit events in the existing audit
  event log only — with copilot-specific event types so audit consumers can
  filter them — and MUST NOT feed the conversation-backed Activity,
  needs-attention, quality, decisions, or history views (FR-008/SC-004 govern
  those surfaces; any audit-backed view that feeds them excludes copilot event
  types).
- **FR-018**: Documentation MUST be updated in the same change: operator-facing
  docs for the copilot surface and proposals, and settings docs if any new
  setting is introduced.
- **FR-019**: The repository MUST gain the catalog coverage check (see New
  Seams): CI fails when a control-plane operation in the OpenAPI registry is
  neither reachable through a catalog tool nor allowlisted with a stated
  reason. The definition-of-done convention — an operator-facing feature ships
  its copilot tool descriptor or an allowlist entry — MUST be recorded in
  `AGENTS.md` in the same change.
- **FR-020**: The catalog MUST expose a `document_chunks` read tool under
  `workspace.documents.read`. It returns workspace-scoped chunk boundaries,
  complete text, metadata, search text, and active-embedding presence for one
  document through an explicit chunk-index range with a strict maximum page
  size. Generic payload compaction MUST NOT truncate chunk text; pagination is
  the payload bound.
- **FR-021**: The catalog MUST expose document reprocessing and configured
  website-source recrawling under `workspace.documents.manage` as `act` tools.
  Reprocessing MAY target one document or the existing documents belonging to
  one source; recrawl MUST resolve the stored website source and its bounded
  crawl settings inside the Documents-owned application service. These tools
  MUST reuse the existing queue, dispatch, audit, and invalidation paths and
  MUST NOT accept a new URL or whole-workspace target.
- **FR-022**: Ray MUST NOT expose `searchRetrievalEvidence` or
  `createRetrievalAnswer` as an agent diagnostic until those operations can
  resolve the selected agent's effective retrieval settings. Agent-attributed
  verification MUST use the real agent execution paths in the interim.

### Wave 3 Knowledge-Base Acceptance Scenarios

1. **Given** a processed workspace document, **When** Ray requests a bounded
   chunk-index range, **Then** it receives complete, untruncated chunk text in
   index order together with offsets, metadata, search text, and embedding
   presence, plus an explicit continuation index when more chunks remain.
2. **Given** a document or source outside the authenticated workspace, **When**
   Ray attempts to inspect or reprocess it, **Then** no protected data or
   mutation is produced.
3. **Given** an existing document or document source, **When** Ray requests a
   reprocess, **Then** the existing asynchronous processing path is queued with
   its normal audit, dispatch, and invalidation behavior and no proposal is
   created.
4. **Given** an existing website source, **When** Ray requests a recrawl,
   **Then** the stored URL, bounded limit, and stored policy are used; a missing
   source, non-website source, or source without a configured URL fails safely.
5. **Given** an agent whose effective retrieval settings differ from workspace
   defaults, **When** Ray diagnoses retrieval before agent-scoped public probes
   ship, **Then** it uses a real agent turn/eval replay and never attributes a
   workspace-default probe result to that agent.

### Key Entities

- **CopilotConversation**: an operator's chat with the copilot; belongs to a
  workspace and an operator account; carries status (idle, running) to serialize
  turns; excluded by construction from customer conversation queries.
- **CopilotMessage**: one entry in a copilot conversation — operator message or
  copilot answer, with the turn's activity summary (tools invoked, outcomes)
  attached for later inspection.
- **CopilotToolDescriptor** (registration-time, not persisted): name, tuned
  description, input/output schemas, required permission, contributing module;
  the unit the composition layer assembles and future MCP admin scope re-exposes.
- **Proposal**: a drafted configuration change — target entity reference (or
  "new entity"), proposed payload, a version token obtained from the target
  type's proposal adapter capturing the state it was drafted against, status
  (pending, applied, dismissed, failed, stale), and the resulting entity
  reference once applied. Initial target types: directive, per-agent setting.
- **CopilotPageContext** (per-turn, not persisted beyond the turn): what the
  operator is viewing — agent, conversation, dashboard view — validated and
  injected as grounding context.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a seeded troubleshooting fixture (agent + conversation with a
  known configured cause), an operator can go from "this conversation looks
  wrong" to a grounded explanation naming the responsible configuration or
  trace stage entirely inside the dashboard, using only a dashboard session —
  no workspace API token is involved anywhere in the flow (enforced by D1 and
  verified by test).
- **SC-002**: In a seeded troubleshooting scenario with a known cause, the
  copilot's explanation identifies the actual cause, and every workspace-specific
  claim in the answer is attributable to a tool result from that turn.
- **SC-003**: An operator can accept a recommendation and have the change live on
  the agent through a proposal card without hand-editing configuration forms, and
  the applied entity always matches the previewed content exactly.
- **SC-004**: No copilot conversation ever appears in Activity, quality,
  decisions, or customer history surfaces, verified by test.
- **SC-005**: A copilot turn's first streamed token arrives within an interactive
  bound (target: under 5 seconds on a workspace with default settings), and no
  turn exceeds its wall-time budget without a visible outcome.
- **SC-006**: Every turn records its model token usage and per-tool invocation
  counts in observability, tool results are size-bounded by their schemas
  (targeted reads, never corpus or source dumps), and the runtime budgets cap
  worst-case consumption per turn — so per-turn cost is always measurable and
  bounded, substantiating the "cheaper than the external-agent workflow" claim
  with recorded data rather than assertion.
