# Implementation Plan: Visitor Context Variables

**Branch**: `visitor-context-awareness` | **Date**: 2026-06-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/097-visitor-context-variables/spec.md`

## Summary

Introduce **Context Variables**: a workspace-declared, per-agent-enabled, scope-resolved
entity that supplies host context (page, identity, cart, anything) to a turn as structured
staged context — available to answer composition, Directive matching, and Routine binding —
and persisted per turn for operators. The fixed page fields become built-in variables. The
work is sequenced so the first slice is a behavior-preserving refactor (unify the two page
renderers + structure + persist), and each later slice adds one capability (catalog/enablement,
resolver fetch, routine binding, trust/identity) behind the same seams.

## Technical Context

**Language/Version**: TypeScript on Node.js 24 (backend), React 19 / Next.js 16 (frontend)
**Primary Dependencies**: Express, Zod, Kysely (spec 093), Pino; conversation-engine /
conversation-contract packages
**Storage**: PostgreSQL 16 + `pgvector`; new tables `context_variables`,
`agent_context_variables`, `context_variable_values`; per-turn snapshot on
`messages.metadata_json` (preferred) — see Open Decisions
**Testing**: Vitest (unit/integration/contract), Supertest, Playwright
**Project Type**: web (backend + frontend + packages)
**Performance/Constraints**: resolution must not add a serial LLM round-trip; resolver fetches
are bounded-timeout and best-effort; no raw context values in logs/traces/metrics
**Scale/Scope**: per-workspace catalog (tens of variables), per-agent enablement, per-turn
resolution on the hot chat path

## Constitution Check

*GATE: passes; re-check after Phase 1 design.*

- Spec exists; status Draft — **implementation MUST NOT begin until approved**.
- Backend TDD: each slice writes failing unit/contract tests first (resolution ordering, scope
  ladder, binding validation, signing verification, redaction).
- Frontend visible behavior (catalog UI, agent enablement section, Activity context panel) →
  Playwright; unit tests only for adapters/transforms.
- Stack unchanged (Node + React + Postgres/pgvector). LLM provider unchanged; the context
  block is prompt scaffolding, not assistant copy.
- Secrets: per-agent signing key derived from `WORKSPACE_TOKEN_SECRET`; update `.env.example`
  if any new env is introduced (expected: none beyond existing secret).
- Customer data: per-turn snapshot and values are PII; redaction + retention addressed
  (FR-009, FR-008).
- Module boundaries explicit (see Seams). Context module → skills module one-way.
- **Application composition**: the resolver port, the context-resolution service, and the
  `ContextVariableRegistry` (built-ins) are app-wide infrastructure → wire defaults in
  `backend/src/app/composition/`; keep resolution rules in the domain module.
- **HTTP contracts change** (catalog + enablement CRUD, public-chat payload extension) →
  update `backend/src/app/http/openapi/document.ts`; `openapi.yaml`/`openapi.json` are
  generated outputs (run `generateOpenApi`).
- **Cross-service contracts**: public chat request schema and the routine binding contract
  change → message-queue impact review (below); the SDK/embed payload gains optional context.
- **Docs**: embed/identity setup, the context settings surface, and signing snippet are
  product surfaces → docs updated in the same work (read `docs/document-writer-prompt.md`).

**Message-queue impact**: resolver fetches run inline on the turn (not via the document
worker), so AMQP payloads/retry semantics are unaffected. The only contract touch is the
public-chat HTTP request (additive, optional) and the routine binding kind (additive). No
worker dispatch changes expected — confirm during Phase 1.

## Source Code (repository root)

```text
backend/
├── src/
│   ├── modules/
│   │   ├── context-variables/                 # NEW domain module
│   │   │   ├── domain.ts                       # ContextVariable, enablement, scope, surfacing types
│   │   │   ├── contextResolutionService.ts     # resolve enabled vars → StagedContext[] (pre-matching)
│   │   │   ├── scopeResolver.ts                 # session→customer→agent→workspace ladder
│   │   │   ├── resolvers/                       # ContextValueResolver port + pushed/browser/skill impls
│   │   │   ├── signing/                         # signed-payload verifier (canonical, HMAC, replay)
│   │   │   ├── contextBlockRenderer.ts          # the SINGLE shared prompt-block renderer
│   │   │   ├── registry.ts                      # built-in variable descriptors (page_*, visitor_identity)
│   │   │   └── redaction.ts                     # sensitive-value redaction for persist/observe
│   │   ├── chat/services/
│   │   │   ├── chatSessionPreparer.ts           # CALL resolution; put fragments on PreparedSession
│   │   │   ├── chatAnswerSupport.ts             # DELETE buildPageContextBlock → renderer
│   │   │   └── retrievalTurnSkill.ts            # DELETE buildPromptWithPageContext → renderer
│   │   ├── routines/
│   │   │   ├── domain.ts                         # RoutineInputBinding += contextVariableRef
│   │   │   ├── validator.ts                      # validate contextVariableRef kind
│   │   │   └── skillArgumentResolver.ts          # resolve contextVariableRef from staged context
│   │   └── agents/
│   │       ├── domain.ts / agentRepository.ts    # per-agent enablement read/write + export/import
│   ├── db/repositories/contextVariableRepository.ts   # NEW (Kysely)
│   ├── db/migrations/                            # 3 new tables + built-in seed + enablement backfill
│   ├── app/composition/                          # wire registry, resolver port defaults, service
│   └── app/http/routes/                          # catalog + enablement CRUD; public-chat schema ext
│       └── openapi/document.ts                   # register new endpoints/schemas
└── tests/                                        # unit + contract + integration per slice

frontend/
├── app/(dashboard) agent config                  # NEW "Context" section (three-column nav sibling)
├── components/                                    # catalog list, enablement form, Activity context panel
└── lib/radioso-embed-launcher.js                 # optional identify()/signed payload (Slice 5)

docs/                                              # embed/identity setup, context settings, signing
```

**Structure Decision**: a dedicated `backend/src/modules/context-variables/` domain module owns
declaration, scope resolution, resolver invocation, signing, and rendering. The chat module
*calls* it from `chatSessionPreparer`; the routines module *consumes* staged values via a new
binding kind. Persistence is a focused Kysely repository. Composition wires the registry +
resolver-port defaults. No existing file absorbs new product logic.

## Module Ownership & Seams

- **Transport**: `publicChatRoutes.ts` + `publicChatRouteSchemas.ts` carry the (optionally
  signed) context payload; `api-public-chat.ts` / embed launcher send it. Catalog/enablement
  CRUD routes translate requests only.
- **Orchestration**: `chatSessionPreparer.ts` invokes `contextResolutionService` once per turn
  **before** matching and attaches `StagedContext[]` to `PreparedSession`.
- **Domain**: `context-variables/` (resolution, scope ladder, resolver port, signing, renderer,
  registry, redaction). Routine binding rules stay in `routines/validator.ts`.
- **Persistence**: `contextVariableRepository.ts` (Kysely); per-turn snapshot via message
  metadata writer; `context_variable_values` upserts.
- **Application Composition**: register `ContextVariableRegistry`, default `ContextValueResolver`
  implementations, and the resolution service in `backend/src/app/composition/`.
- **Files Kept Small**: `chatSessionPreparer.ts` gains a single call, not resolution logic;
  `retrievalTurnSkill.ts` / `chatAnswerSupport.ts` *lose* code (renderer extracted out);
  route handlers stay transport-only.
- **Planned Extractions**: `ContextValueResolver` port; `contextBlockRenderer`;
  `contextResolutionService`; `contextVariableRef` binding kind.
- **Required Refactor Stories**: Slice 1 is itself the refactor (extract one renderer) and must
  land before later slices depend on the staged fragment.

## Phased Delivery

Each slice is independently testable, shippable, and behind the same staged-context seam.

### Slice 1 — Unify renderer + structured staging + per-turn persistence (US1, P1)
- Extract one `contextBlockRenderer`; replace `buildPageContextBlock` and
  `buildPromptWithPageContext`. **Golden-output parity tests** against current grounded block
  before deleting either.
- Represent page context as `StagedContext{ kind: "context_variable" }` built in
  `contextResolutionService` (page built-ins resolved from the request payload).
- Resolve **before** Directive matching; pass fragments to both composers and the matcher.
- Persist redacted per-turn snapshot on `messages.metadata_json`; surface in Activity.
- No new tables required for built-ins-from-request, but introduce the registry + service.
- *Tests*: parity (grounded + non-grounded), resolution-before-matching, snapshot persisted
  per turn (multi-page conversation), Activity Playwright.

### Slice 2 — Catalog + per-agent enablement + scope-keyed values (US2, P2)
- Migrations: `context_variables`, `agent_context_variables`, `context_variable_values`;
  seed built-ins; backfill enablement for existing agents (page built-ins, `source=browser`,
  `surfacing=always`).
- Repository (Kysely) + CRUD routes + OpenAPI regen.
- `pushed` source: host-backend sets values via API keyed by `(scope_type, scope_id)`.
- Scope resolver (ladder), surfacing policy (`always`/`on_reference`/`operator_only`),
  sensitivity/redaction.
- Frontend: workspace "Context" catalog + agent "Context" section; export/import (079).
- *Tests*: scope ladder precedence, surfacing renders vs operator_only hidden, redaction,
  CRUD contract, export/import round-trip.

### Slice 3 — Resolver-backed (on-demand) variables (US3, P3)
- `ContextValueResolver` `skill`/`webhook` impl: invoke `resolver_skill_id` with bounded
  timeout, TTL caching via `max_age_seconds`, no in-turn retry, graceful degradation.
- Observability: resolver latency, cache hit/miss, failure (no raw values).
- *Tests*: fetch on miss, cache hit within TTL, refetch after TTL, timeout→absent→turn
  proceeds, failure does not 500.

### Slice 4 — Routine binding via `contextVariableRef` (US4, P3)
- `RoutineInputBinding` gains `contextVariableRef`; `validator.ts` validates (enabled on agent,
  type compatible) and treats it as optional for guarantee analysis;
  `skillArgumentResolver.ts` resolves from staged context.
- Routine editor: bind a slot source to an enabled variable.
- *Tests*: auto-fill from ambient value (no prompt), fall through to resolver/prompt when
  absent, guarantee-analysis soundness, validator diagnostics.

### Slice 5 — Trust tiers + signed identity (FR-018/019)
- `signed` browser source: canonical payload + HMAC verify + timestamp window + nonce replay +
  origin/session binding + key rotation; identity→customer scope mapping unlocks
  `customer`-scoped resolution.
- Embed launcher: `identify()` + signed payload; docs + snippet.
- *Tests*: valid signature accepted, tamper/expired/replayed/origin-mismatch rejected→absent,
  rotation window, customer-scoped values resolve only after verified identity.

## Risks & Mitigations

- **Hot-path latency**: resolution adds work to every turn. Mitigate: built-ins resolve from
  the request (no I/O); pushed/scoped values are single indexed reads; resolver fetches are
  opt-in, TTL-cached, timeout-bounded. No new serial LLM call.
- **Parity regression in Slice 1**: golden-output tests gate the renderer swap before deletion.
- **PII leakage**: centralized `redaction.ts` applied at persist + observability boundaries;
  sensitive values never rendered when `operator_only`.
- **Guarantee-analysis soundness** (routines): `contextVariableRef` is optional-by-default so
  it cannot falsely satisfy a required-input entry guarantee.
- **Identity spoofing**: only `signed` values gate account answers; unverified is
  personalization/operator-visibility only.

## Open Decisions (for review)

1. **Per-turn persistence**: `messages.metadata_json` (preferred — no migration, turn-scoped,
   already in Activity) vs dedicated `context_turn_snapshots` table.
2. **Catalog scope**: workspace catalog + per-agent enablement (recommended) vs fully per-agent
   declarations.
3. **`on_reference` dependency declaration**: where a Directive/Routine declares its structured
   dependency on a variable id (new field on the directive/routine record) — confirm the shape.

## Post-Design Gates

- Re-run Constitution Check after Phase 1 (`research.md`/contracts).
- `pnpm run ci:local -- origin/main` before PR; OpenAPI regenerated; docs updated.
