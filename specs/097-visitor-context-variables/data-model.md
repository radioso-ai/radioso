# Data Model: Visitor Context Variables

This model introduces one config entity (the **declaration**), one runtime store (the
**value**), and one per-agent wiring row (the **enablement**), plus a turn-time projection
into the existing staged-context spine and a redacted per-turn snapshot (message-level, not
`conversations.channel_context`) for operator display.

The variable is its own entity. It is **not** a row in `agent_skills`; a skill appears only
as the optional resolver a variable's enablement references.

## Layering

```text
Workspace
  └── context_variables (the catalog — declare once)            [CONFIG]
         id · name · description · value_type · trust_tier
            · sensitivity · default_surfacing
              │ enabled per agent
              ▼
Agent
  └── agent_context_variables (per-agent wiring)                [CONFIG]
         agent_id · variable_id · source · resolver_skill_id?
            · max_age_seconds? · resolver_timeout_ms? · surfacing · enabled
              │ resolved each turn (scope ladder)
              ▼
context_variable_values (scope-typed runtime store)            [RUNTIME]
         variable_id · scope_type · scope_id · data(JSON) · last_modified
              │ resolved BEFORE directive matching / routine eval
              ▼
PreparedSession.stagedContext  (kind = "context_variable")     [TURN]
         available to: directive matcher · routine binding · answer renderer
              │ persisted per turn (resolved snapshot, redacted)
              ▼
per-turn store: messages.metadata_json (or context_turn_snapshots)  [PERSISTED]
         (conversations.channel_context is NOT used — it stays the
          typed Slack/web source envelope, index.d.ts:47)
```

## context_variables (NEW — workspace catalog)

The declaration. Holds no value.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid FK | scope of the catalog |
| name | text | identifier used in routine bindings and `on-reference` matching; valid identifier; `UNIQUE (workspace_id, name)` |
| description | text | shown to the model and the operator; helps the LLM interpret the value |
| value_type | text | `string` \| `json` (advisory; values are JSON-serializable either way) |
| trust_tier | text | CHECK in (`unverified`, `signed`). Gates account-specific use. |
| sensitivity | text | CHECK in (`normal`, `sensitive`). `sensitive` ⇒ redacted from logs/traces/metrics. |
| default_surfacing | text | CHECK in (`always`, `on_reference`, `operator_only`). Default for enablements. |
| created_at / updated_at | timestamptz | |

Built-in variables (`page_context` — a single bundle of the page fields, decision A — and
`visitor_identity`) are defined in a **code registry** (`context-variables/registry.ts`), NOT
seeded as catalog rows. Seeding per-workspace rows for built-ins would require backfilling
every existing and future workspace; instead built-ins are implicitly available and resolved
in code (Slice 1 already resolves `page_context` with zero DB rows). The catalog tables below
therefore hold ONLY host-defined variables. Operators enable/wire built-ins through the same
per-agent enablement, but cannot delete or rename them.

## agent_context_variables (NEW — per-agent enablement/wiring)

Mirrors the per-agent association pattern of `agent_directives` / `agent_skills`. This is the
operator's main lever and is part of agent export/import (spec 079).

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| agent_id | uuid FK | |
| variable_id | uuid FK → context_variables | |
| source | text | CHECK in (`pushed`, `browser`, `resolver`). Where the value comes from. |
| resolver_skill_id | uuid FK → agent_skills | NULL unless `source = resolver`; the skill/webhook fetched on demand |
| max_age_seconds | integer | cache TTL: refresh only when the stored value is older than this. NULL ⇒ refresh every turn. Only meaningful when `source = resolver`. |
| resolver_timeout_ms | integer | bounded per-call timeout; on expiry the value is treated as absent (FR-007) |
| surfacing | text | CHECK in (`always`, `on_reference`, `operator_only`). Overrides the variable's default. |
| enabled | boolean | |
| created_at / updated_at | timestamptz | |

**Invariants:**
- `UNIQUE (agent_id, variable_id)`.
- `source = resolver` ⇒ `resolver_skill_id` NOT NULL; otherwise it MUST be NULL.
- `source = browser` ⇒ if `trust_tier = signed`, a verification key must be configured
  (see Trust below); unverified browser values MUST NOT be used for account-gated answers.
- `max_age_seconds` / `resolver_timeout_ms` are rejected unless `source = resolver`.

## context_variable_values (NEW — scope-keyed runtime store)

Values live separately from declarations and are keyed by scope, so one variable holds many
per-visitor values. **Operators do not normally write here** — the host backend (pushed), the
resolver (fetched), or the browser (per-turn, not stored) populate it.

Scope is modeled as an explicit `(scope_type, scope_id)` pair — not an opaque `scope_key`
string — so types are constrained, indexes are clean, and ownership is unambiguous.

| Field | Type | Notes |
|---|---|---|
| id | uuid PK | |
| workspace_id | uuid FK | denormalized for indexing/tenant isolation |
| variable_id | uuid FK → context_variables | |
| scope_type | text | CHECK in (`session`, `customer`, `agent`, `workspace`) |
| scope_id | text | the id within that scope: anonymous session id, customer id, agent uuid, or workspace uuid |
| data | jsonb | arbitrary JSON; max size enforced (FR-013) |
| last_modified | timestamptz | drives TTL freshness comparison |

**Invariants:**
- `UNIQUE (variable_id, scope_type, scope_id)` (upsert target).
- Index `(workspace_id, variable_id, scope_type, scope_id)` for resolution lookups.
- `customer` scope requires an established conversation identity (FR-019); rows at
  `scope_type = customer` are owned by the identity subsystem, keyed by the verified customer
  id, never by an anonymous session id.
- Browser-sourced values are turn-scoped and are NOT persisted here; they exist only on the
  request and the staged fragment.

### Scope resolution (per turn, before matching)

For each enabled variable, resolve a value by trying `(scope_type, scope_id)` pairs
**most-specific first**, first hit wins:

```text
(session, <sessionId>) → (customer, <customerId>) → (agent, <agentId>) → (workspace, <wsId>)
```

The `(customer, …)` rung is only attempted once a verified identity has established the
customer scope (FR-019); anonymous sessions skip it and fall through to agent/workspace
defaults. Resolution runs **before** Directive matching and Routine evaluation (FR-004) so a
Directive can be conditioned on a variable.

For `source = resolver`: read the stored value; if absent or older than the enablement's
`max_age_seconds` (a NULL TTL ⇒ always refresh), invoke `resolver_skill_id` (bounded timeout,
no in-turn retry, keyed to session/customer). On success, upsert and use; on
timeout/error/skip, the variable contributes nothing and the turn proceeds (FR-007). Latency,
cache hit/miss, and failures are emitted to observability without raw values.

## Trust

- `unverified` — pushed-by-host (operator trusts their own API), or browser-supplied. Browser
  unverified values are framed as untrusted in the prompt and never gate account answers.
- `signed` — a browser-supplied value verified before use (FR-018). The signing contract:

  | Concern | Decision |
  |---|---|
  | Canonical payload | deterministic serialization (sorted keys, no insignificant whitespace) of `{ variableName, value, customerId?, sessionId, origin, issuedAt, nonce }` |
  | Signature | HMAC-SHA256 over the canonical payload, per-agent key derived from `WORKSPACE_TOKEN_SECRET` (contact-delivery precedent) |
  | Freshness | `issuedAt` within a bounded acceptance window (e.g. ±5 min) |
  | Replay | `nonce`/`jti` recorded and rejected on reuse within the window |
  | Binding | payload `sessionId`/`origin` MUST match the established embed session/origin |
  | Identity → customer | a verified `visitor_identity` maps its `customerId` to the `customer` scope (FR-019); subsequent `customer`-scoped resolution uses it |
  | Key rotation | overlapping key validity — verify against current and previous key during a rotation window |
  | Failure | any check fails ⇒ value dropped (treated as absent), turn never errors |

The signing key is configuration, stored per the existing secret pattern; never committed,
surfaced to the operator as the snippet to embed on their site.

## Projection into the turn

- All enabled variables are resolved **before** Directive matching / Routine evaluation and
  become `StagedContext` fragments of `kind = "context_variable"` on `PreparedSession`,
  alongside the retrieval fragment. Resolution is independent of surfacing.
- A single shared renderer turns fragments into one prompt block, used by every composer
  (replacing both `buildPageContextBlock` and `buildPromptWithPageContext`). Surfacing governs
  **rendering only**: `always` ⇒ every turn; `on_reference` ⇒ only when a matched Directive or
  active Routine **declares a structured dependency** on the variable *by id* (never by
  scanning rule/prompt text for the name — no-keyword-lists rule); `operator_only` ⇒ never
  rendered.
- Because resolution precedes matching, the Directive matcher and Routine binding see resolved
  values regardless of surfacing, so a routine slot bound via `contextVariableRef` is
  auto-filled from the resolved value.

## Per-turn persistence (operator view)

`conversations.channel_context` is **not** the target: it is a typed conversation-level
Slack/web source envelope (`conversation-contract/index.d.ts:47`) and a conversation spans
many turns and pages, so a single conversation-level bag would clobber both the source
envelope and earlier turns' context.

Resolved context is persisted **per turn**, redacted for `sensitive` variables. Two options
for the plan to choose:

- **A — `messages.metadata_json`** (preferred): write the redacted resolved snapshot under a
  reserved `contextVariables` key on the user/assistant message row. Reuses an existing JSONB
  column, naturally turn-scoped, already surfaced to Activity.
- **B — `context_turn_snapshots`** table (`conversation_id`, `message_id`, `data jsonb`,
  `created_at`) if message metadata proves too coupled.

Either way, `operator_only` variables are persisted for Activity but never rendered into the
prompt. Activity displays the snapshot for the relevant turn, so a later turn on a different
page shows that turn's page, not an overwritten value.

## Routine binding (`contextVariableRef`)

The routine input-binding contract gains a third kind alongside `literal` and the
slot/skill-output `ref` (`validator.ts:300-325`, `skillArgumentResolver.ts:9-16`):

| Binding kind | Shape | Validation | Runtime resolution |
|---|---|---|---|
| `literal` (existing) | `{ kind:"literal", value }` | type/enum match | inline value |
| `ref` (existing) | `{ kind:"ref", ref }` | `ref` ∈ declared slots / skill outputs | `state.variables[ref]` |
| `contextVariableRef` (NEW) | `{ kind:"contextVariableRef", contextVariable }` | variable name enabled on agent; `value_type` compatible with input type | resolved staged context value for `contextVariable` name |

**Guarantee semantics:** a `contextVariableRef` binding is *optional* by default — the value
may be absent at runtime — so it does NOT satisfy a required input's entry guarantee on its
own (`guaranteedVariablesOnEntry`, `validator.ts:327`). A resolver-backed variable with a
guaranteeing resolver MAY be declared as satisfying the guarantee; otherwise the step must
tolerate absence (prompt fallback). This keeps the existing guarantee analysis sound.

## Migration & backfill

1. Create `context_variables`, `agent_context_variables`, `context_variable_values`
   (migration `112_context_variables.sql`). No seed, no backfill.
2. Built-ins (`page_context`, `visitor_identity`) live in the code registry, not the DB, so no
   seeding/backfill is needed; `page_context` already resolves and renders (Slice 1).
3. Per-turn persistence (shipped in Slice 1): the redacted snapshot rides on
   `messages.metadata_json.contextVariables`. `conversations.channel_context` is left untouched.
4. Kysely types are regenerated from the migrations via `pnpm --dir backend run db:types`
   (throwaway pgvector container), which also validates the migration SQL.

Persistence access uses Kysely per spec 093 (no raw SQL outside the sanctioned allowlist).

## What each table knows

- `context_variables` — *what a piece of context is*. Knows nothing about agents, values, or
  resolvers' internals.
- `agent_context_variables` — *how one agent gets and surfaces it*. References a skill as a
  resolver but does not know how that skill executes.
- `context_variable_values` — *the data, per scope*. Knows nothing about prompts or agents
  beyond the scope key.
- The resolver skill lives in `agent_skills` and is unaware it is feeding a context variable.

Dependency direction: context module → skills module (for resolver execution) and → staged
context contract. Neither skills nor the conversation engine depends on the context module's
internals; they consume the staged fragment and the resolver port.
