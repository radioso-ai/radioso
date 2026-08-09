# Feature Specification: Portable Agent Authoring (Radioso as an Engine)

**Feature Branch**: `100-portable-agent-authoring`
**Created**: 2026-07-13
**Status**: Approved (requestor approved in session 2026-07-13 after review revisions;
open-question recommendations accepted as decisions — see Resolved Decisions)
**Input**: User description: "Let's think about how people are going to use Radioso as an engine. The API layer is robust, but on the routine/directive/context side there is a syntax-sugar option and a raw-form option, and it's not clear how this works as an engine — perhaps a semi-standard syntax or SDK."

## Context

Radioso already has three surfaces a developer could use to drive it as an engine, and
they do not line up:

1. **REST API** — full CRUD and lifecycle for routines, directives, and context
   variables, but routines are accepted only as the raw structured
   `RoutineDefinition` graph or via `draft-assist` (LLM compilation of free prose,
   no fidelity guarantee). There is no deterministic text intake.
2. **TypeScript SDK** — wraps agents, documents, chat, and settings, but exposes no
   `routines`, `directives`, or `contextVariables` methods even though the generated
   OpenAPI types exist in `typescript-sdk/src/generated/types.ts`.
3. **Conversation kit** (`packages/conversation-*`) — a complete embeddable engine
   with a code-first SDK, but its authoring store shares no format with the platform.

Meanwhile the semi-standard syntax already exists: the portable routine markdown
grammar (frontmatter, `@vars`, `#skills`, `-> end` jumps, `[if ...]` guards) built in
the prose↔form parity work (PR #782, #845). It is deterministic, round-trip-tested,
and covers every routine feature — but it lives only in
`frontend/lib/routine-prose-tokens.ts` as a copy/paste convenience. Its own comment
claims it "mirrors the backend routine-document grammar", and no such backend module
exists. Separately, the `AgentConfig` projection (spec 079,
`backend/src/modules/agents/agentConfig.ts`, schemaVersion 3) is internal-only
(eval snapshots, workbench replay), has no HTTP endpoint, and excludes routines and
context-variable enablements — so a complete agent cannot round-trip.

This feature promotes the existing grammar to a shared engine contract, completes the
agent bundle so a whole agent is portable data, and closes the SDK gap. Positioning:
Radioso's answer is "agents are data with a
human-writable syntax" — the same definition renders as dashboard chips, lives as a
file in a repo, travels through the API and SDK, and (as a follow-up) loads into the
standalone kit.

Out of scope: publishing the kit packages (roadmap decision D5), a text grammar for
directives (they stay structured; their complexity is relational, not structural), and
any authoring-canvas UI.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Author routines as deterministic markdown via the API (Priority: P1)

A developer keeps an agent's routines as portable-markdown files in their repository.
They create and update routines by sending that markdown to the routines API and get
the same markdown back when they read a routine — parsed and serialized by the same
deterministic grammar the dashboard chip editor uses, with no LLM involved and no
loss of meaning in either direction.

**Why this priority**: This is the missing port everything else plugs into. The
grammar already exists and is round-trip-hardened; it is stranded in the frontend as
a product feature instead of being the engine's canonical text form.

**Independent Test**: `POST` a routine in markdown covering every grammar element
(slots with flags, skill bindings with typed IO, guards, jumps, terminals, action
steps, completion export), publish it, read it back as markdown, and verify the
round-trip is canonical-form stable and the published routine behaves identically to
the same routine created via the structured JSON body.

**Acceptance Scenarios**:

1. **Given** a routine expressed in portable markdown, **When** it is submitted to
   the routine create/update endpoints in markdown format, **Then** it is parsed
   deterministically (no LLM call), validated by the existing validator, and persisted
   as the same `RoutineDefinition` the structured intake would produce.
2. **Given** a persisted routine (regardless of how it was created), **When** it is
   read in markdown format, **Then** the returned text re-parses to an equivalent
   definition, and stable step/slot ids survive the round trip so a subsequent update
   re-points rather than recreates steps.
3. **Given** markdown that violates the grammar or produces an invalid definition,
   **When** it is submitted, **Then** the request fails with diagnostics that identify
   the offending line/token (grammar errors) or reuse the existing validation
   diagnostic codes (semantic errors), and nothing is persisted.
4. **Given** a routine slot bound to a context variable (`contextVariableRef`),
   **When** it is serialized and re-parsed, **Then** the binding survives — closing
   the known gap where the grammar encodes only `literal` and `variableRef` bindings.
5. **Given** the dashboard chip editor, **When** it serializes or parses routine text,
   **Then** it uses the same shared grammar package as the backend — the frontend's
   local grammar module is deleted, not forked.

---

### User Story 2 - Export and import a complete agent bundle (Priority: P2)

An operator exports an agent as a single portable bundle — settings, directives,
routines (embedded as portable markdown), context-variable enablements, and skill
configuration — checks it into version control or moves it between workspaces and
environments, and imports it to get a behaviorally equivalent agent.

**Why this priority**: "Agent as data" (spec 079) exists but cannot round-trip a real
agent: the projection is internal-only and excludes routines and context-variable
enablements. Without a complete bundle there is no unit of exchange for GitOps,
staging→production promotion, sharing, or backup.

**Independent Test**: Configure an agent with directives, published routines, context
variables, and skill settings; export the bundle; import it into a different
workspace; verify the imported agent's exported bundle is equivalent and that an eval
replay of a representative conversation produces equivalent turn handling.

**Acceptance Scenarios**:

1. **Given** a configured agent, **When** its bundle is exported over the API,
   **Then** the bundle contains agent settings, authored directives, routine
   definitions in portable markdown, and context-variable enablements, versioned with
   a bundle schema version, with non-portable references and secrets replaced by the
   existing placeholder mechanism.
2. **Given** a valid bundle, **When** it is imported as a new agent, **Then** all
   authored elements are created with their relationships intact (directive
   scope tags referencing routines/steps resolve to the imported routines' stable
   ids), and elements whose placeholders cannot be resolved (e.g. selected source
   ids, logo) import in a disabled/unbound state that the response enumerates.
3. **Given** a bundle referencing a skill or context variable that does not exist in
   the target workspace, **When** it is imported, **Then** the import either fails
   atomically or (when the caller opts into partial import) reports each unresolved
   reference explicitly — never silently dropping behavior.
4. **Given** an export request, **Then** only published routine definitions and saved
   directives are included; unsaved drafts are not part of the portable surface.
5. **Given** any import or export, **Then** an audit event records who moved which
   agent's configuration and the outcome.

---

### User Story 3 - Author a full agent from the TypeScript SDK (Priority: P3)

A developer building on hosted Radioso configures an entire agent — settings,
directives, routines (markdown or structured), context variables, and bundles —
through typed SDK methods, without hand-rolling `fetch` calls against endpoints whose
generated types they already have.

**Why this priority**: The SDK is the first thing an "engine" developer reaches for;
today it stops at agents/documents/chat, which forces raw REST for exactly the
authoring surfaces this feature is about. It is deliberately after US1/US2 because it
mostly wraps what they create.

**Independent Test**: Using only the published SDK, create an agent, add a directive,
create and publish a markdown routine, enable a context variable, export the bundle,
and re-import it — no direct HTTP calls.

**Acceptance Scenarios**:

1. **Given** the SDK client, **When** a developer uses `routines`, `directives`, and
   `contextVariables` namespaces, **Then** all existing CRUD and lifecycle operations
   (including validate/publish/revise and coherence results) are available with types
   matching the OpenAPI contract.
2. **Given** the SDK client, **When** a developer exports or imports an agent bundle,
   **Then** typed methods cover both, and import surfaces unresolved-reference
   results as structured data.
3. **Given** SDK docs in the docs portal, **When** a developer follows the
   "author an agent programmatically" guide, **Then** the examples cover markdown
   routine intake and bundle round-trip.

---

### User Story 4 - Same definitions run in the embedded kit (Priority: P4)

A developer embedding the conversation kit loads an agent bundle exported from the
platform (or authored as files) into the kit's authoring store, so the same agent
definition runs hosted or embedded.

**Why this priority**: This completes the engine story, but it depends on US1/US2
stabilizing the formats, and the kit is not yet published (D5) — so this slice is
groundwork, not launch.

**Explicit prerequisite**: the kit runs the compiled graph contract
(`@radioso/conversation-contract` `Routine`), while the grammar package parses to a
`RoutineDefinition`. Lowering definition→graph is `modules/routines/compiler.ts`,
which stays backend-owned through US1–US3. US4 therefore REQUIRES extracting the
definition types, validator, and compiler into the shared definition package
(FR-016) before the kit loader can exist — forking the compiler into the kit is
prohibited (see Anti-Goals). If that extraction is judged too heavy when US4 is
picked up, US4 must be re-scoped, not worked around.

**Independent Test**: Export a bundle from the platform, load it via a kit API, run a
conversation through the kit's engine, and observe directives steering and routines
activating equivalently.

**Acceptance Scenarios**:

1. **Given** an exported bundle, **When** it is loaded into the kit's authoring
   store, **Then** agents, directives, and routines are registered without manual
   translation, with host-supplied hooks for the pieces the kit cannot portably
   express (skill implementations, resolver functions).
2. **Given** a routine authored as a portable-markdown file, **When** the kit host
   registers it, **Then** the kit parses it with the same shared grammar package.

---

### Edge Cases

- Markdown that parses but compiles to an invalid graph (unreachable step, dangling
  jump target): must return the existing validator diagnostics, not a parse error.
- Grammar evolution: a bundle or markdown document written against an older grammar
  or bundle schema version — versions must be declared and rejected/migrated
  explicitly, never guessed.
- Stable-id collisions on import (bundle ids already exist in the target agent):
  import into an existing agent is an overwrite/merge decision — see open questions.
- A bundle exported with `sensitivity: sensitive` context variables or signed-identity
  configuration must not leak signing keys or values; only definitions and
  enablements travel.
- Concurrent edits: markdown update racing a chip-editor update on the same routine —
  last-write semantics must match today's structured PATCH behavior.
- Very large bundles (many routines) and markdown documents near the existing 50k
  char prose limit: limits must be explicit and documented.
- `draft-assist` (LLM prose) remains available and unchanged; its output must never
  be confused with the deterministic path in API shape, docs, or telemetry.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider (note: the deterministic
  markdown path in this feature makes no LLM calls at all).
- User-facing assistant or chat responses MUST NOT rely on hard-coded application
  strings; runtime conversational copy MUST be generated by the LLM.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests
  MUST stay focused on non-visual logic.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST
  be updated if new configuration appears.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain
  logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited
  rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The routine text grammar becomes a shared workspace package
  (working name `@radioso/routine-markdown`): pure functions, no backend, frontend,
  Express, React, or LLM dependencies. It depends on a shared routine-definition
  types package (working name `@radioso/routine-definition`) that must be created
  first — today `RoutineDefinition`/draft types live only in
  `backend/src/modules/routines/domain.ts` as backend Zod schemas, so hoisting them
  (types and schemas together, so validation cannot drift from the types) is explicit
  prerequisite work (FR-016), not an assumed substrate. Backend routes stay
  transport-only (format handling lives in a named mapper, not in handlers).
  Semantic validation (`validator.ts`) and graph lowering (`compiler.ts`) remain
  backend-owned through US1–US3; US4 moves them into the shared definition package
  as one extraction — never a copy. Bundle projection stays in
  `modules/agents/agentConfig.ts` and grows a named import/export service rather
  than inflating `agentService`.
- **Encapsulation Rule**: `frontend/lib/routine-prose-tokens.ts` is deleted in favor
  of the shared package — the frontend keeps only chip-editor UI concerns.
  `routine-prose.ts` (chip-document mapping) may stay frontend-local, but it MUST
  round-trip every binding kind the grammar supports (FR-004a): a projection layer
  that silently drops `contextVariableRef` on save would violate this feature's own
  no-silent-behavior-loss rule from inside the dashboard. `assist.ts`
  (LLM draft-assist) remains a separate, clearly convenience-labeled path and MUST
  NOT be routed through by the deterministic intake. The SDK's hand-written client
  wrapper stays a thin typed veneer over generated types.
- **New Seams Required**: (1) shared routine-definition types package (prerequisite,
  FR-016); (2) shared grammar package with a versioned canonical serializer;
  (3) a bundle export/import service with an explicit reference-resolution step
  (placeholder → target-workspace binding); (4) SDK namespaces for
  routines/directives/context-variables/bundles; (5) US4 only: validator + compiler
  extraction into the definition package, then a kit authoring loader that consumes
  the bundle.
- **Anti-Goals**: Do not put LLM calls in the deterministic path. Do not invent a
  directive text grammar. Do not build an authoring canvas. Do not introduce a new
  storage system — the structured `RoutineDefinition` remains the data of record and
  markdown remains a projection. Do not fork the grammar, definition types, or
  compiler (no second copy anywhere, including the kit — sharing happens by
  extraction, never duplication). Do not publish the kit packages in this feature
  (D5 stays a separate decision). Do not expand `draft-assist` scope.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The routine portable-markdown grammar MUST live in one shared package
  consumed by backend, frontend, and (US4) the kit, with `serialize` and `parse` as
  inverse functions over a documented, versioned grammar. Every serialized document
  MUST self-declare its grammar version in frontmatter; the parser MUST treat a
  missing declaration as the defined pre-versioning grammar (version 1), never as
  "latest", and MUST reject versions it does not support with an explicit
  diagnostic rather than best-effort parsing.
- **FR-002**: The routines API MUST accept routine create and update in markdown
  form alongside the existing structured format (transport mechanism per OQ-006),
  parsed deterministically with no model-provider dependency.
- **FR-003**: Routine read endpoints MUST offer a markdown representation whose
  re-parse yields an equivalent definition, preserving stable step and slot ids.
- **FR-004**: The grammar MUST cover every authorable routine element, including
  context-variable input bindings (closing the known `contextVariableRef` gap).
- **FR-004a**: The dashboard chip-document layer (`routine-prose.ts` and the chip
  editor) MUST preserve every binding kind through an open→edit→save cycle. A
  context-bound routine created via the API MUST NOT lose its binding when saved
  from the dashboard; at minimum the binding renders as a preserved (even if not
  richly editable) chip.
- **FR-005**: Grammar errors MUST return line/token-level diagnostics; semantically
  invalid definitions MUST return the existing validator diagnostic codes; failed
  submissions MUST NOT persist partial state.
- **FR-006**: The agent configuration projection MUST be extended (new schema
  version) to include routine definitions and context-variable enablements, with
  routines embedded in portable markdown form.
- **FR-007**: Agent bundle export and import MUST be available over authenticated
  workspace REST endpoints, using the existing placeholder mechanism for
  non-portable references and secrets; secret values MUST never be exported.
- **FR-008**: Import MUST resolve cross-references (directive scope tags → routine
  stable ids, bindings → skills, context-variable references) and MUST report every
  unresolved reference explicitly; silent behavior loss is prohibited.
- **FR-009**: Bundle import and export MUST emit audit events; import/export and
  markdown parse failures MUST be observable (structured logs and counters) without
  logging document content, prompts, or secrets.
- **FR-010**: The TypeScript SDK MUST expose typed namespaces for routines
  (including lifecycle), directives (including coherence results), context variables
  (definitions, enablement, values), and bundle export/import.
- **FR-011**: OpenAPI MUST describe the new format negotiation and bundle endpoints,
  and the SDK regeneration chain MUST be run as part of the change.
- **FR-012**: Docs MUST ship in the same change: a portable-markdown format
  reference (the grammar as public contract), bundle export/import docs, and SDK
  authoring examples in the docs portal.
- **FR-013**: The LLM `draft-assist` path MUST remain distinct in API shape and
  documentation, described as a convenience generator without fidelity guarantees.
- **FR-014** (US4): The kit MUST provide a loader that registers agents, directives,
  and routines from a bundle, with host hooks for non-portable pieces (skill
  implementations, resolvers). This REQUIRES the validator and compiler to have
  moved into the shared definition package (FR-016 second stage); the kit MUST NOT
  contain its own definition→graph lowering.
- **FR-015**: Existing structured-format clients (dashboard, current API users) MUST
  be unaffected: the structured intake, validation, lifecycle, and compiled runtime
  behavior are unchanged.
- **FR-016**: Routine definition types and their validation schemas MUST be hoisted
  from `backend/src/modules/routines/domain.ts` into a shared package before the
  grammar package is built (US1 prerequisite), keeping types and schemas together so
  backend validation cannot drift from the shared types. Validator and compiler
  extraction into the same package is deferred to US4 and MUST happen as a move,
  with the backend consuming the extracted modules.

### Key Entities

- **Routine portable document**: the markdown text form of one routine definition;
  a projection of `RoutineDefinition`, never the data of record; versioned grammar.
- **Agent bundle**: versioned JSON document (evolved `AgentConfig`) containing agent
  settings, authored directives, routine portable documents, context-variable
  enablements, and skill settings, with placeholders for non-portable references.
- **Reference placeholder**: existing `AgentConfigRefPlaceholder` /
  `AgentConfigSecretPlaceholder` mechanism, now also covering routine/skill/context
  cross-references at import time.
- **Unresolved-reference report**: structured import result enumerating each element
  imported disabled/unbound and why.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the existing prose↔form parity test corpus round-trips through
  the shared package byte-stably in canonical form, from both backend and frontend
  consumers — and the frontend's private grammar module no longer exists.
- **SC-002**: A markdown-created routine and its structured-JSON twin produce
  identical compiled runtime graphs (excluding timestamps/ids assigned at creation).
- **SC-003**: An agent exported from one workspace and imported into another passes
  an eval replay of a representative conversation set with equivalent turn handling
  (same directives matched, same routines activated).
- **SC-004**: A developer can configure a complete agent (settings, directive,
  published markdown routine, context variable, bundle round-trip) using only the
  SDK — zero raw HTTP calls — following only the docs-portal guide.
- **SC-005**: The deterministic markdown path makes zero model-provider calls,
  verified by test instrumentation.
- **SC-006**: Every import that drops or disables behavior says so: no bundle import
  can yield a silently degraded agent (audited by the unresolved-reference report
  being non-empty exactly when any element imported unbound).

## Resolved Decisions *(open questions resolved at approval, 2026-07-13)*

Each question below is retained with its analysis; the stated recommendation was
accepted as the decision. In summary:

- **OQ-001 → DECIDED**: US2 ships import-as-new-agent; `apply` into an existing
  agent (keyed on stable ids) is specified but may land as a fast follow.
- **OQ-002 → DECIDED**: import is fail-fast by default with an `allowPartial`
  opt-in.
- **OQ-003 → DECIDED**: bundles carry workspace-level context-variable definitions;
  import creates-if-missing by name and reports conflicts.
- **OQ-004 → DECIDED**: two small packages — `@radioso/routine-definition` (types +
  schemas; validator + compiler join at US4) and `@radioso/routine-markdown`
  (grammar). Bundle types stay backend-owned until US4 forces them shared.
- **OQ-005 → DECIDED**: authors may omit stable ids; first create assigns them and
  returns the canonical document to commit back; reads always return canonical
  form; a persistence-free `canonicalize` operation ships for CI use.
- **OQ-006 → DECIDED**: all-JSON transport — `{ grammarVersion, content }` envelope
  on a portable sub-resource (`GET/PUT /agents/{agentId}/routines/{id}/portable`,
  plus markdown-envelope create); structured endpoints are not overloaded with
  content-type negotiation.

### Original questions and analysis

- **OQ-001**: Import into an *existing* agent (update-in-place keyed on stable ids —
  the GitOps `apply` case) vs. import-as-new-agent only. Recommendation: ship
  import-as-new in US2; specify `apply` semantics but allow it to land as a fast
  follow, since stable ids already make it well-defined.
- **OQ-002**: Placeholder resolution UX on import: fail-fast by default with an
  explicit partial-import opt-in, or always-partial with a report? Recommendation:
  fail-fast default, `allowPartial` opt-in.
- **OQ-003**: Does the bundle carry workspace-level context-variable *definitions*
  (which are shared across agents) or only the agent's enablements plus a reference?
  Recommendation: carry definitions; import creates-if-missing by name and reports
  conflicts.
- **OQ-004**: Package naming and topology: separate `@radioso/routine-definition`
  (types + schemas, later validator + compiler) and `@radioso/routine-markdown`
  (grammar) packages, vs. one combined authoring package that also owns bundle
  types. Leaning: two small packages; bundle types stay with the backend until US4
  forces them shared.
- **OQ-005**: Canonical-form churn for files in a repo (the gofmt problem). Stable
  ids are server-assigned and the canonical serializer normalizes formatting, so a
  hand-authored file will not byte-match what the API returns — every API round-trip
  would rewrite the developer's file. Needs a documented stance: recommendation is
  (a) authors MAY omit stable ids; the first create assigns them and returns the
  canonical document, which the developer commits back (analogous to
  `prettier --write` / lockfile update); (b) reads always return canonical form;
  (c) ship a `canonicalize` operation (parse+serialize, no persistence) so CI can
  enforce canonical files without touching the server state. Entangled with OQ-001
  (`apply` needs id-stable files to diff).
- **OQ-006**: Transport mechanism for the markdown format on the API. Content-type
  negotiation (`text/markdown` vs `application/json`) on the existing endpoints
  fights the OpenAPI→SDK generation chain (FR-011) and therefore SC-004.
  Recommendation: keep everything `application/json` — a JSON envelope
  (`{ grammarVersion, content }`) on a portable sub-resource
  (`GET/PUT /agents/{agentId}/routines/{id}/portable`, plus markdown-envelope
  create), rather than overloading the structured endpoints. Decide before planning;
  FR-002/FR-003 are written mechanism-neutral on purpose.
