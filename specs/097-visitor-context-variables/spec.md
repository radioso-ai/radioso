# Feature Specification: Visitor Context Variables

**Feature Branch**: `visitor-context-awareness`
**Created**: 2026-06-24
**Status**: Approved
**Input**: User description: "Radioso is lacking visibility into user identity on the site or what page the user is looking at, so it can't summarize or talk about what the user is experiencing. Generalize beyond fixed fields (page, identity) to any host-supplied context (username, cart, order, anything) that can be injected into a turn when needed — including when a routine needs it."

## Overview

Today the embed widget collects a small, fixed set of fields (`pageUrl`, `pageTitle`,
`pageLocale`, `browserLocale`, optional page `content`). The backend already injects them on
both answer paths, but through **two divergent renderers** — `buildPageContextBlock` for the
non-retrieval path and `buildPromptWithPageContext` for the grounded and grounded-miss paths
(`retrievalTurnSkill.ts:119`, `:173`). The fields are **never persisted**, are **not
structured staged context** (so Directives/Routines cannot see them), and the **set cannot
grow without code changes**. There is no notion of *who* the visitor is or any host-defined
attribute (cart, order, plan, etc.).

This feature introduces **Context Variables**: a first-class, schema-flexible entity that
declares a named piece of contextual information, resolves a value for the current
conversation from one of several sources, and makes that value available to the turn —
to grounded and non-grounded answers, to Directives, and to Routines. Today's fixed page
and identity fields become built-in context variables; `cart`, `order_status`,
`account_tier`, etc. become workspace-defined ones with no per-field migration.

A Context Variable is **data/state that may reference a resolver**, not a capability in its
own right. It sits alongside Skill / Directive / Routine as the fourth platform concept.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unify, structure, and persist page context (Priority: P1)

Page context already reaches both the grounded and non-grounded answer paths, but via two
separate renderers and as an unstructured prompt string. This slice replaces both renderers
with one structured staged-context fragment, persists the resolved context per turn so an
operator can see it later, and makes it available to Directive matching and Routine binding —
without changing the visitor-facing behavior of "summarize this page".

**Why this priority**: Highest-value, lowest-risk foundation. It introduces no new trust
surface and no new collected data; it converts an existing ad-hoc string into the staged,
persisted, reusable substrate every later story builds on. It is a behavior-preserving
refactor plus persistence.

**Independent Test**: Run a grounded turn and a non-grounded turn with page context supplied;
assert both render the page block through the single renderer and produce equivalent answers
to today. Assert the resolved context is persisted at turn granularity and surfaced in
Activity.

**Acceptance Scenarios**:

1. **Given** a visitor on `/blog/onboarding`, **When** they ask a question that triggers
   grounded retrieval, **Then** the page block is rendered via the unified renderer (parity
   with current `buildPromptWithPageContext` output).
2. **Given** the same visitor, **When** the question is answered without retrieval, **Then**
   the same unified renderer produces the page block (replacing `buildPageContextBlock`).
3. **Given** a completed turn, **When** an operator opens the conversation in Activity,
   **Then** the page URL/title/locale captured **for that turn** are displayed (a later
   turn on a different page shows that turn's page, not an overwritten conversation-level
   value).
4. **Given** a Directive declared to depend on page locale, **When** a turn runs, **Then**
   the resolved page context is available to the Directive matcher before matching.

### User Story 2 - Host-defined ambient context (Priority: P2)

A workspace admin defines a context variable `cart` whose value is supplied by the host
site's backend per identified visitor. When that visitor chats, the assistant can reason
about the cart contents and Directives/Routines can be conditioned on it.

**Why this priority**: This is the generalization the feature exists for — any host-supplied
attribute, not a fixed list. Depends on the staging/injection seam from US1.

**Independent Test**: Define a `cart` variable, set a value scoped to a customer/session via
the API, run a turn for that session, and assert the value appears in the turn's staged
context block and is available to the Directive matcher.

**Acceptance Scenarios**:

1. **Given** a `cart` variable with a value set for the current session, **When** a turn
   runs, **Then** the value (arbitrary JSON) is rendered into the context block.
2. **Given** no value set for the current session, **When** a turn runs, **Then** the
   variable contributes nothing and the turn proceeds normally.
3. **Given** a variable flagged sensitive, **When** the turn is traced/logged, **Then** the
   raw value is not emitted to observability output.

### User Story 3 - On-demand (resolver-backed) context (Priority: P3)

A workspace admin attaches a resolver (a registered skill or a webhook to the host backend)
to an `order_status` variable, with a freshness window. When a turn needs the value and the
cached value is stale, Radioso fetches a fresh value via the resolver; when it is fresh, the
cache is reused.

**Why this priority**: Highest complexity (new outbound fetch, latency, failure handling).
Builds on US2's variable model; the resolver is an *attachment* to a variable, reusing the
unified-skills / webhook spine rather than a new capability type.

**Independent Test**: Attach a stub resolver and a freshness rule; run two turns inside the
window (one fetch, one cache hit) and one after expiry (re-fetch); assert fetch counts and
that a resolver failure degrades gracefully (turn proceeds without the value).

**Acceptance Scenarios**:

1. **Given** a resolver-backed variable with no cached value, **When** a turn needs it,
   **Then** the resolver is invoked and the result cached and injected.
2. **Given** a cached value within its freshness window, **When** a turn runs, **Then** the
   resolver is NOT invoked and the cached value is used.
3. **Given** a cached value past its freshness window, **When** a turn runs, **Then** the
   resolver is invoked again and the cache updated.
4. **Given** a resolver that errors or times out, **When** a turn runs, **Then** the turn
   completes without that variable and the failure is recorded (not surfaced as a 500).

### User Story 4 - Routine slot bound to a context variable (Priority: P3)

A routine step that needs `cart` is satisfied automatically from the `cart` context variable
instead of asking the visitor, falling through to a resolver fetch if no ambient value
exists.

**Why this priority**: Directly answers "when a routine needs it". Reuses the existing
routine skill input/output binding; a context variable is just another bindable source.

**Independent Test**: Bind a routine slot to the `cart` variable; run the routine with an
ambient value present (auto-filled) and absent (resolver-fetched or, failing that, prompted).

**Acceptance Scenarios**:

1. **Given** a routine slot bound to `cart` and an ambient `cart` value, **When** the step
   activates, **Then** the slot is filled from the variable without prompting the visitor.
2. **Given** no ambient value but a resolver attached, **When** the step activates, **Then**
   the resolver supplies the slot value.

### Edge Cases

- **Anonymous sessions**: most embed sessions have only an anonymous session id, not a
  customer identity. Per-customer values only apply once identity exists; otherwise values
  resolve at session/agent/workspace scope.
- **Untrusted browser input**: page context (and any browser-pushed value) is untrusted and
  MUST be framed as such in the prompt and MUST NOT gate account-specific answers.
- **Spoofed identity**: an unverified browser-pushed identity MUST NOT unlock account data;
  only a verified (signed) identity may.
- **PII & retention**: persisted context (emails, cart, URLs with query strings) is customer
  data and needs redaction in observability and a retention story.
- **Token budget**: not every variable should be injected on every turn; sensitive/large
  variables need a surfacing policy rather than always-inject.
- **Resolver latency/failure**: must degrade to "no value", never block or fail the turn.
- **Value too large**: oversized values must be truncated/rejected at a defined bound.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be Node.js; frontend MUST be React.
- Database MUST be PostgreSQL with `pgvector`.
- LLM integrations MUST use the configured default provider; conversational copy MUST come
  from the LLM (no hard-coded assistant strings). The current-page/context block is
  scaffolding around the prompt, not assistant copy.
- Backend development MUST follow TDD.
- Frontend visible behavior (admin config UI, Activity display) MUST prefer Playwright.
- Secrets (resolver signing keys) MUST live in `.env`; `.env.example` MUST be updated.
- Customer data MUST be least-privilege and securely transmitted; sensitive variables MUST
  be redactable.
- Admin pages MUST use the shared dark theme and existing design tokens.
- Boundaries between transport, orchestration, domain, and persistence MUST be preserved.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**:
  - *Transport* — embed launcher + public chat routes carry typed, opaque context payloads
    and signatures; they do not interpret field meaning.
  - *Orchestration* — the conversation engine / `ChatSessionPreparer` resolves enabled
    variables for the turn and emits them as `StagedContext` fragments.
  - *Domain* — a new context-variable module owns the declaration, scope resolution, value
    keying, and freshness logic.
  - *Persistence* — variable declarations and values live in their own tables; the resolved
    context for a turn is persisted at turn/message granularity (e.g. `messages.metadata_json`
    or a dedicated turn-context store), NOT on `conversations.channel_context` (which keeps its
    typed Slack/web source-envelope shape — `conversation-contract/index.d.ts:47`).
- **Encapsulation Rule**: the two existing renderers — `chatAnswerSupport.buildPageContextBlock`
  (non-retrieval) and `buildPromptWithPageContext` (grounded / grounded-miss,
  `retrievalTurnSkill.ts:119`,`:173`) — must be replaced by a single context-fragment renderer
  used by all composers, preserving the current grounded output. The public chat route stays
  transport-only. The retrieval prompt builder must receive context as input, not reach for it.
- **New Seams Required**:
  - `ContextVariable` declaration store + value store (scope-keyed).
  - A `ContextVariableResolver` port with implementations: `pushed` (value set via API /
    host backend), `browser` (untrusted, signed-optional), `skill`/`webhook` (on-demand,
    freshness-gated).
  - A turn-level `ContextResolutionService` that produces `StagedContext[]` for the prepared
    session.
  - A renderer that turns resolved context into a single prompt block.
- **Anti-Goals**:
  - Do NOT model context as a new "skill capability type"; a variable *references* a resolver,
    it is not a capability.
  - Do NOT trust browser-pushed identity for account-gated answers.
  - Do NOT add a second page-context code path; unify the existing one.
  - Do NOT dump every variable into every prompt regardless of size/sensitivity.
  - Do NOT put resolution or scoping logic in the route handler.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST let a workspace declare named Context Variables with a description,
  scope, optional resolver, optional freshness window, and a sensitivity/surfacing flag.
- **FR-002**: A Context Variable value MUST be arbitrary JSON (string, object, list).
- **FR-003**: Values MUST be keyed by scope and resolved most-specific-first along the ladder
  **session → customer → agent → workspace** (first hit wins).
- **FR-004**: System MUST **resolve** all enabled variables for a turn **before** Directive
  matching and Routine evaluation, and make the resolved values available to the Directive
  matcher, Routine binding, and answer composition. Resolution is independent of surfacing
  (FR-016): a variable is resolved and available even when its surfacing is `on_reference` or
  `operator_only`.
- **FR-005**: The current-page/context block MUST be rendered through a **single** shared
  renderer used by all answer paths, replacing the two existing renderers
  (`buildPageContextBlock` and `buildPromptWithPageContext`). Output parity with the current
  grounded page block MUST be preserved.
- **FR-006**: Browser-supplied context MUST be treated as untrusted in the prompt and MUST
  NOT gate account-specific answers unless verified via a signed payload (FR-018).
- **FR-007**: Resolver-backed variables MUST fetch on demand and cache by an explicit
  **max-age TTL** (refresh only when the stored value is older than the TTL; no TTL ⇒ refresh
  every turn). Resolver calls MUST have a bounded timeout, MUST NOT auto-retry within a turn,
  MUST be safe to skip, and MUST degrade gracefully (turn proceeds without the value) on
  timeout/error. Resolver latency, cache hit/miss, and failure MUST be observable (without
  raw values).
- **FR-008**: Resolved context for a turn MUST be persisted at **turn/message granularity**
  (not on the conversation-level `channel_context` source envelope, which MUST keep its
  existing Slack/web shape). A conversation that spans multiple pages MUST retain each turn's
  context, and Activity MUST display per-turn context. Sensitive values are redacted at rest
  per FR-009.
- **FR-009**: Variables flagged sensitive MUST be redacted from logs/traces/metrics.
- **FR-010**: Today's page fields MUST be reimplemented as built-in context variables with no
  loss of current behavior.
- **FR-011**: Routine skill inputs MUST be bindable to a Context Variable via a new
  `contextVariableRef` binding kind (the current validator accepts only `literal` and
  references to declared slots / skill-output variables — `validator.ts:310`,
  `skillArgumentResolver.ts:13`). The binding contract MUST define: validation that the
  referenced variable is enabled on the agent; type compatibility between the variable's
  declared `value_type` and the skill input type; and **guarantee semantics** — a
  context-variable binding is treated as *optional* (the value may be absent at runtime)
  unless the variable is resolver-backed with a guaranteed value, so it MUST NOT, on its own,
  satisfy a required input's entry guarantee.
- **FR-012**: Per-agent settings MUST control which variables are enabled and their surfacing,
  threading through agent export/import.
- **FR-013**: Variable values MUST have a maximum size; oversized values are rejected or
  truncated at a defined bound.
- **FR-014**: Context Variables MUST be a configuration entity distinct from Skills. A
  variable MUST NOT be created as, or registered in, the skill registry. A variable MAY
  *reference* a skill (or webhook) as its on-demand resolver.
- **FR-015**: Operators MUST declare variables once at workspace scope (a catalog) and enable
  them per agent, where per-agent enablement carries the value source and surfacing policy.
- **FR-016**: Each enabled variable MUST have a surfacing policy controlling **prompt
  rendering only** (not resolution, per FR-004): `always` (render every turn), `on_reference`
  (render only when a matched Directive or active Routine **declares a structured dependency**
  on the variable by id — never by scanning prompt/rule text for the name, per the
  no-keyword-lists rule), or `operator_only` (never rendered into the prompt; visible to
  operators in Activity).
- **FR-017**: Operators MUST be able to view the resolved context values for a conversation
  in Activity/HITL, read-only and redacted for sensitive variables. Operator value editing
  is limited to workbench preview and HITL takeover (session-scoped override).
- **FR-018**: A `signed` browser-supplied value MUST be verified before use. The signing
  contract MUST define: a canonical, deterministic serialization of the signed payload; an
  HMAC over that payload using a per-agent key (derived from `WORKSPACE_TOKEN_SECRET`); a
  signature timestamp with a bounded acceptance window and a nonce (or jti) for replay
  rejection; binding to the session/origin already established for the embed; and a key
  rotation path (overlapping key validity). A failed verification MUST drop the value (treat
  as absent), never error the turn.
- **FR-019**: A signed `visitor_identity` MUST establish the conversation's `customer` scope
  identity; only after identity is established do `customer`-scoped values resolve. Anonymous
  sessions resolve only at `session`, `agent`, and `workspace` scope. The mapping from a
  verified identity to a customer scope id MUST be explicit and stable.

### Key Entities *(include if feature involves data)*

- **Context Variable (declaration)**: `{ name, description, scope, resolver?, freshnessRule?,
  trustTier (unverified|signed), sensitivity, surfacing }`. Owned per workspace; enabled per
  agent. Does not hold a value.
- **Context Variable Value**: `{ variableId, scopeKey, data (JSON), lastModified }`. Keyed by
  `(variableId, scopeKey)` where `scopeKey` encodes session/customer/agent/workspace.
- **Resolver**: a port — `pushed` (host backend / API), `browser` (embed-supplied, optionally
  signed), or `skill`/`webhook` (on-demand fetch with freshness).
- **Agent Context Enablement**: the per-agent association that turns a catalog variable on for
  one agent and carries its value source binding (pushed / browser / resolver reference) and
  surfacing policy. Analogous to the per-agent Directive/Skill association rows.
- **Staged context fragment**: the existing per-turn context-fragment shape; context variables
  become fragments of a dedicated kind.

## Operator Control Surface *(mandatory)*

Context Variables are configured, not coded, and the control model has three layers plus a
read-only runtime view. The variable is its own entity — it is NOT managed from the Skills
tab; skills appear only as the optional resolver a variable points at.

1. **Declare (workspace catalog)** — a workspace-level "Context" surface where an operator
   defines a variable once: name, description, value type, scope, trust tier, sensitivity,
   default surfacing. Reusable across agents so `cart`/`order_status` are not re-defined per
   agent.
2. **Enable + wire (per agent)** — a new agent-config section, sibling to Directives and
   Routines in the three-column nav. The operator enables a catalog variable for the agent,
   chooses its value source (pushed via API / browser-supplied / resolver skill or webhook +
   freshness window), and sets the surfacing policy (`always` / `on-reference` /
   `operator-only`). Persisted as a per-agent association and included in agent
   export/import.
3. **Consume (per routine)** — in the existing Routine editor, a routine slot's source can be
   bound to an enabled variable, reusing the routine skill input/output binding.
4. **Runtime view (Activity / HITL)** — operators see the resolved context for a conversation,
   read-only and redacted for sensitive variables.

Operators control declarations and wiring, not values. Values are runtime data from the host
backend, the resolver, or the browser. The only operator value-writes are workbench preview
(pin a sample value) and HITL takeover (session-scoped override) — both narrow, neither part
of the catalog.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: "Summarize this page" returns a page-grounded answer on both the retrieval and
  non-retrieval paths in 100% of turns where page context is supplied.
- **SC-002**: An operator can see the visitor's page (and any enabled identity/context) for a
  conversation in Activity without code changes per field.
- **SC-003**: A new host-supplied attribute can be added by configuration alone — zero schema
  migrations and zero changes to transport or prompt code.
- **SC-004**: A resolver-backed variable produces at most one fetch per freshness window and
  never causes a turn to error when the resolver fails.
- **SC-005**: No sensitive variable value appears in logs, traces, or metrics.
- **SC-006**: A routine slot bound to a context variable is auto-filled from an available
  value without prompting the visitor.
