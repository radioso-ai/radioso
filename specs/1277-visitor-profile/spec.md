# Feature Specification: Visitor profile — request facts, geo, and cross-conversation linkage

**Feature Branch**: `visitor-identity-enrichment`
**Created**: 2026-09-18
**Status**: Draft
**Issue**: #1277
**Input**: "Shall we build a bit more info on our AI users? IP, country, previous conversations etc?"

## Why this exists

Radioso knows almost nothing about the person on the other end of a
conversation. Identity is smeared across five `conversations` columns
(`anonymous_session_id`, `verified_customer_id`, `source_origin`,
`entry_page_url`, `channel_context`); nothing captures IP, country, browser or
language; nothing models a visitor across conversations; and the operator
drawer's "Visitor context" panel (`conversation-drawer.tsx:151`) reads a
`contextVariables` field the history API never sends.

The gap has a product cost on both sides of the conversation. Operators
triaging the Inbox cannot tell a returning customer from a first-time visitor,
cannot see where a visitor is or what language their browser speaks, and cannot
follow a visitor from one conversation to the next. Agents cannot condition a
directive on country ("mention EU shipping for DE") or on browser language,
even though the context-variables substrate that feeds directive matching
(spec 097, #838) is already in place.

The two primitives that exist — an anonymous session id
(`anonymous_session_id`) and a host-signed customer id (`verified_customer_id`)
— are the right raw material; what is missing is the entity that joins them,
the request facts that describe each visit, and durability for the anonymous
id. Today that id is effectively **per tab** on the embed: the launcher keeps
the resume token in `sessionStorage`
(`frontend/lib/radioso-embed-launcher.js:465-490`, chosen so the teaser and
greeting reset per tab), and the backend's `anon_session_*` cookie is
`SameSite=Lax` (`resolveAnonymousSession.ts:346`), which browsers do not send
from a third-party iframe. The 30-day server TTL
(`publicChatSession.ts:6`) is therefore never exercised across tabs. Without
fixing that, "previous conversations" would only link within one tab.

## Boundaries (what each part knows)

| Part | Knows | Must not know |
|------|-------|---------------|
| Frontend proxy routes (`frontend/app/api/public/chat/[token]`, `frontend/app/api/embed/session/[token]`) | The client-facing request: socket/LB-forwarded address, geo headers the load balancer stamped, `User-Agent`, `Accept-Language`; the edge signing secret | What Radioso does with the facts; visitors; conversations |
| `@radioso/edge-proof` (new, generic) | How to sign and verify a canonical JSON envelope bound to a context string, method, path and time; the request-facts payload schema both edges agree on | Conversations, visitors, MCP |
| `@radioso/mcp-source-proof` | Its existing address-digest proof, now built on `@radioso/edge-proof` (extraction-only; behaviour and headers unchanged) | Visitor facts |
| Embed launcher (host page) | Where the durable visitor key lives (`localStorage`) and that it goes in the bootstrap body | What the key links to server-side; sessions |
| `VisitorGeoResolver` port + header adapter (composition) | Which forwarded header carries country/region/city and in what precedence | Conversations, visitors, the drawer |
| `visitors` module (`backend/src/modules/visitors/`) | Identity resolution rules (verified beats visitor key, key upgrades to verified, never re-attach a key to a second verified id), the `visitors` table | HTTP, headers, geo, the LLM |
| Chat session preparer | That a conversation is created with a `visitorId` and a `requestContext` | How either was derived |
| Context-variables registry | A built-in `visitor_request` variable with `source: "request"` | IP or user agent — they never enter this module |
| History service + drawer | How to present a visitor and their previous conversations to an operator | Proof verification, geo header names |

Dependency direction: HTTP edge → chat services → visitors module → repository.
Composition wires the geo adapter and the proof secret; no domain module reads
`process.env`.

## Decisions taken in this spec

1. **Raw IP is stored** (`request_context.clientIp`), shown to operators, and
   kept out of every LLM-facing surface (context variables, prompts, traces).
   Rationale: operators need it for abuse and fraud triage, and it is standard
   for this product class. No conversation-level delete exists in the product
   today (`conversationRepository.ts` has no delete method; only Ray's
   `copilot_conversations` are ever deleted), so retention is: facts live as
   long as the conversation, and workspace deletion cascades. Privacy docs name
   the fields and say so.
2. **Previous conversations are operator-only** in this spec. Agent-side
   cross-conversation memory (summaries injected into the next conversation) is
   a separate feature with its own identity-strength question.
3. **Edge facts travel in a signed envelope, not by proxy-hop counting.** Two
   ingress paths reach the backend (LB → backend for API clients; LB → frontend
   proxy → backend for the embed), so a single `trusted hops` number cannot be
   right for both. The frontend proxy signs what it observed with a shared
   secret. `@radioso/mcp-source-proof` already has the canonical-payload HMAC
   signing but is MCP-specific by name, consumers (`radioso-mcp-server`,
   backend rate limiters) and Dockerfile wiring (backend only), and it
   deliberately returns only an address *digest*. The generic envelope is
   extracted into a new `@radioso/edge-proof` package that both the frontend
   proxy and the backend depend on; `mcp-source-proof` is refactored onto it
   with its digest path and headers unchanged.
4. **Country comes from a header the load balancer stamps**, resolved through a
   port. Cloud: GCP `{client_region}` / `{client_city}` custom request headers on
   `google_compute_backend_service.frontend_app` (`infra/terraform/cdn.tf`) —
   a separate infra PR, because live/live-eu applies are drift-sensitive. Self-
   hosted: Cloudflare (`CF-IPCountry`) and similar well-known headers work with
   no configuration; anything else is one env var. No GeoIP database ships.
5. **A `visitors` entity exists** rather than a derived query over two string
   columns, because this is the moment it earns its keep: one join for previous
   conversations, one place the drawer reads, a merge point when an anonymous
   visitor verifies, and a single deletion target.
6. **A separate durable visitor key, not a reused session id.** The launcher
   generates a uuid on first visit, keeps it in host-page `localStorage` (scoped
   by embed token) and sends it as `visitorKey` in the bootstrap body. The
   backend binds it into the signed public chat session at issuance; on resume
   the session's own key wins, so a client cannot change it mid-session. The
   key's only power is grouping conversations under one `visitors` row for
   operators. It never resumes a session, never reads history and never
   replaces the per-session `anonymous_session_id` — PR #456 removed
   client-supplied session ids for exactly that reason and that hardening
   stays. A spoofer holding someone else's key can only make their own new
   conversation appear under that visitor in the drawer; verified identity
   remains the strong link. Teaser/opened flags and resume tokens stay in
   `sessionStorage`, so per-tab greeting UX is unchanged.

## User Scenarios & Testing

### User Story 1 — Operator sees who they are talking to (Priority: P1)

An operator opens a conversation in the Inbox. The drawer's **Visitor** panel
shows: country (with region/city when the edge provided them), browser and OS
family, browser language, entry page, referrer, IP address, first seen, and
"3 previous conversations" linking to each.

**Why this priority**: it is the whole point of the request; every other
scenario is a consequence of having the data.

**Independent test**: with the stack running behind the proxy, open the embed
from a page, send one message, open the conversation in the Inbox. The Visitor
panel shows the IP the proxy observed, the country from the stubbed geo header,
the browser from `User-Agent`, and `Accept-Language`. Open the embed again from
the same browser; the second conversation's panel lists the first under
"Previous conversations".

**Acceptance scenarios**:

1. **Given** an embed conversation whose first message reached the backend
   through the frontend proxy with a valid edge proof, **when** the operator
   opens it, **then** the panel shows IP, country, browser, language, entry page
   and referrer.
2. **Given** a request that carries the proxy marker but no valid proof, **when**
   the conversation is created, **then** IP/country/browser/language are `null`
   (not the proxy's own address), and a counter increments.
3. **Given** a REST API client conversation with no proxy marker, **when** it is
   created, **then** IP is derived from the socket / trusted-hop suffix and
   country from the LB header when present.
4. **Given** a second conversation from the same browser in a new tab, **when** the
   operator opens either, **then** the other appears under "Previous
   conversations" with title, date and agent.
5. **Given** a conversation with `purpose = operator_test`, **when** it is
   created, **then** no visitor is created or updated.

### User Story 2 — An anonymous visitor becomes a known customer (Priority: P1)

A shopper chats anonymously twice, then logs in to the store; the host now mints
a signed identity (`verified_customer_id`). From that turn on, the operator sees
one visitor with three conversations, not two strangers and a customer.

**Independent test**: create two conversations with visitor key A; on the third,
send a verified identity token for customer C; the `visitors` row for A now has
`verified_customer_id = C`, and all three conversations resolve to it.

**Acceptance scenarios**:

1. **Given** a visitor row keyed only by visitor key A, **when** a turn on any of its
   conversations verifies customer C and no row for C exists, **then** the row
   gains `verified_customer_id = C`.
2. **Given** a row for visitor key A and a separate row for customer C, **when** a
   turn on A's conversation verifies C, **then** the conversation moves to C's
   row and A's row is unchanged (a shared browser, second account).
3. **Given** a row for visitor key A already bound to customer C, **when** a turn on
   A's conversation verifies customer D, **then** the conversation moves to a
   row for D; A's row keeps C and the visitor key is not re-attached.
4. **Given** two first messages from a brand-new visitor key arriving concurrently,
   **when** both create conversations, **then** exactly one `visitors` row
   exists and both conversations point at it.

### User Story 3 — Directives react to where the visitor is (Priority: P2)

An operator writes a contextual directive "when the visitor is in Germany,
mention that shipping to the EU takes 3–5 days". A visitor from Berlin asks
about delivery; the directive activates.

**Independent test**: add the directive, send a message with the geo header stubbed to `DE`; the turn trace shows the
directive matched and the redacted snapshot shows `visitor_request.country =
"DE"` with no IP or user agent anywhere in the trace.

**Acceptance scenarios**:

1. **Given** request facts on the conversation, **when** a turn runs, **then**
   the match projection carries `{ country, region, city, language, referrer,
   entryPageUrl }` and nothing else.
2. **Given** a conversation with no request facts at all (API client behind
   no load balancer, no page context), **when** a turn runs, **then** the
   variable is absent from the snapshot rather than present with six nulls.
3. **Given** any surface that renders the snapshot (trace, drawer, evals),
   **then** neither `clientIp` nor `userAgent` appears.

### User Story 4 — Self-hosted operator gets country with one setting (Priority: P3)

A self-hosted operator behind Cloudflare sees country populated without
configuration; one behind a custom proxy sets `VISITOR_GEO_COUNTRY_HEADER` and
sees it on the next conversation.

**Acceptance scenarios**:

1. **Given** `CF-IPCountry: NL` on the proxied request and no env override,
   **then** `country = "NL"`.
2. **Given** `VISITOR_GEO_COUNTRY_HEADER=X-Geo` and `X-Geo: FR`, **then**
   `country = "FR"` and the override wins over well-known headers.
3. **Given** no geo header at all, **then** `country = null` and the drawer
   shows the field as unknown rather than omitting the panel.

## Functional Requirements

### Visitors entity

- **FR-001** Migration adds `visitors` (`id uuid pk`, `workspace_id` fk
  cascade, `visitor_key text null`, `verified_customer_id text null`,
  `first_seen_at`, `last_seen_at`, `conversation_count int`, `last_country
  text null`, `last_language text null`, `last_user_agent text null`) with
  unique partial indexes on `(workspace_id, visitor_key)` and
  `(workspace_id, verified_customer_id)`, and `conversations.visitor_id uuid
  null` fk (`ON DELETE SET NULL`) with an index. Both `db:types` and
  `db:schema` snapshots regenerate.
- **FR-002** The same migration backfills: one row per distinct
  `(workspace_id, verified_customer_id)`, then one per distinct
  `(workspace_id, anonymous_session_id)` not already covered by a conversation
  that has a verified id, seeding `visitor_key` from the historical session id
  (each pre-existing session becomes a visitor no browser will present again);
  `visitor_id` set on every `production` conversation with either key; counts
  and first/last seen derived from `created_at`.
- **FR-003** `VisitorResolver.resolveForConversation({ workspaceId,
  visitorKey, verifiedCustomerId, observed: { country, language,
  userAgent } })` returns a `visitorId`, applying: verified id first; else
  visitor key; else insert. `visitorKey` comes from the verified session
  payload; when the session carries none (API channel, sessions issued before
  this change) the per-session `anonymous_session_id` is used as the key, which
  is exactly what the backfill did. Insert uses `ON CONFLICT DO NOTHING` and re-selects.
  Updates `last_seen_at`, `conversation_count`, and the `last_*` observations.
- **FR-004** `VisitorResolver.attachVerifiedIdentity({ conversationId,
  workspaceId, visitorKey, verifiedCustomerId })` runs wherever `setVerifiedCustomerId` runs today
  (`chatSessionPreparer.ts` first verified turn), applying the rules of User
  Story 2 and re-pointing `conversations.visitor_id` when the conversation moves.
- **FR-005** Conversations with `purpose = operator_test` never touch
  `visitors`. Conversations with neither key (Slack, MCP without a session) get
  `visitor_id = null`.
- **FR-006** Workspace deletion cascades to `visitors` via the FK. There is no
  conversation delete path in the product today; if one is added, it must
  decrement `conversation_count` and delete a visitor reaching zero — recorded
  as a constraint in the module README, not built here.
- **FR-007** When a conversation moves to another visitor row (User Story 2,
  scenarios 2–3), both rows' `conversation_count` are adjusted in the same
  transaction and `last_seen_at` of the receiving row is refreshed.

### Durable anonymous visitor key

- **FR-008** The launcher generates a `visitorKey` (uuid) on first visit,
  persists it in host-page `localStorage` under a key scoped by embed token and
  sends it in every bootstrap body. The backend `/sessions` route binds it into
  the signed session payload (`publicChatSessionBasePayloadSchema.visitorKey`,
  nullable); with a resume token the payload's existing key wins. The dead
  `anonymousSessionId` bootstrap body field is removed. New sessions still get
  a random `publicSessionId`; the #456 test "does not resume website embed
  history from a raw anonymous session id" stays green. Resume tokens and
  teaser/opened flags keep their `sessionStorage` behaviour.
- **FR-009** When `localStorage` is unavailable (privacy mode, storage
  disabled, `SecurityError`), the launcher falls back to today's per-tab
  behaviour silently; no console noise at warn level.

### Request facts

- **FR-010** `packages/conversation-contract` gains
  `ConversationRequestContext { clientIp, country, region, city, userAgent,
  acceptLanguage, observedVia: "edge_proof" | "backend" | "unproven" }` (all
  strings nullable, `userAgent` capped at 512 chars, `acceptLanguage` at 256);
  migration adds `conversations.request_context jsonb null` and
  `conversations.entry_referrer text null`.
- **FR-011** `request_context` and `entry_referrer` are set once at conversation
  creation, next to `entry_page_url`, and never overwritten. Creation happens
  on the first real message in `ChatSessionPreparer.prepare()`
  (`chatSessionPreparer.ts:391-405`); the greeting route
  (`ChatBootstrapService.startConversation`) writes only
  `bootstrap_greeting_cache` and creates no row (`publicChatRoutes.ts:601-604`).
  `createWithInitialAssistantMessage` has no production caller and is not a
  second creation path.
- **FR-012** `ConversationRepositoryPort.create` takes a single typed input
  object (replacing the seven positional parameters plus options bag) that
  includes `visitorId`, `requestContext`, `entryReferrer`. Extraction of the
  signature change lands before the behaviour change.
- **FR-013** `entry_referrer` is client-claimed: the launcher sends
  `document.referrer` of the host page alongside `pageUrl` in the bootstrap page
  context. It lives next to `entry_page_url`, not inside `request_context`,
  because the two have different trust.

### Edge proof

- **FR-020** New workspace package `packages/edge-proof` (`@radioso/edge-proof`)
  exports a generic `signEnvelope` / `verifyEnvelope` (context string,
  deterministic JSON canonicalisation, method + path + timestamp binding, 60 s
  window, HMAC-SHA256 with a caller-supplied secret) and the request-facts
  schema `{ clientIp, geoHeaders: Record<string,string>, userAgent,
  acceptLanguage }` under context `radioso:edge-facts:v1`. It is registered
  everywhere AGENTS.md requires: `infra/frontend.Dockerfile` and
  `infra/backend.Dockerfile` (package.json copy stage and runtime `--from`
  copies), `backend/package.json` `build:workspace-deps` and test scripts,
  `frontend/package.json` dependency.
- **FR-020a** `@radioso/mcp-source-proof` is refactored to build on
  `@radioso/edge-proof` as an extraction-only change (same headers, same
  `PROOF_CONTEXT`, same digest semantics, existing tests unchanged), landed as
  its own commit before the behaviour change.
- **FR-021** The two frontend proxy routes always send `x-radioso-edge:
  frontend`; when the secret is configured they also send the proof headers.
  The client address at the edge is resolved from the LB-appended
  `X-Forwarded-For` suffix using the frontend's own `RADIOSO_TRUSTED_PROXY_HOPS`
  (same suffix rule as `resolveSourceDigest`, returning the address; the rule
  moves into `@radioso/edge-proof` so both ends share it), falling back to the
  socket address. The frontend has no validated env module today; these routes
  read the variables through one small `frontend/lib/server/edge-env.ts`
  helper rather than inline `process.env`.
- **FR-022** `geoHeaders` at the edge = the well-known set (`x-client-region`,
  `x-client-city`, `cf-ipcountry`, `x-appengine-country`, `x-vercel-ip-country`,
  `x-vercel-ip-country-region`, `x-vercel-ip-city`). Header names are protocol
  identifiers, not product vocabulary. There is no operator override; the
  well-known set is the whole mechanism.
- **FR-023** Backend public chat routes derive `ConversationRequestContext`:
  valid proof → `observedVia: "edge_proof"`, facts from the payload; marker
  without valid proof → all facts `null`, `observedVia: "unproven"`; no marker →
  `observedVia: "backend"`, IP from socket/trusted suffix, `geoHeaders` from
  the request's own headers. A spoofed marker can only hide a caller, never
  forge facts.
- **FR-024** `VisitorGeoResolver.resolve(geoHeaders) → { country, region, city
  }` is a port; the header adapter applies precedence GCP → Cloudflare →
  Vercel → App Engine, normalises country to upper-case ISO 3166-1 alpha-2,
  and returns `null` for anything else. Wired in composition.

### Context variable

- **FR-030** `ContextVariableSource` gains `"request"`; registry gains
  `visitor_request` (`source: "request"`, `valueType: "json"`, `surfacing:
  "always"`, `trustTier: "unverified"`, `sensitivity: "normal"`). The value is
  accepted everywhere the enum is locked today: the
  `agent_context_variables.source` CHECK constraint (migration 112, line 19 —
  a migration alters it), the `.strict()` enablement snapshot schema in
  `backend/src/modules/agents/agentRevision.ts:35-39`, and the OpenAPI enum.
  A test publishes a revision whose snapshot parses with the widened enum.
- **FR-030a** Resolution is a new, small seam, not a reuse: the three existing
  sources resolve through `ContextVariableResolutionReaderPort` against
  `context_variable_values`, and `resolveContextForTurn` has no view of the
  conversation record. `resolveContextForTurn` gains a `requestFacts` input
  (the conversation's `request_context` + `entry_page_url` + `entry_referrer`,
  already narrowed per FR-031) supplied by the preparer; the resolver never
  reads `conversations` itself.
- **FR-031** The narrowing to `{ country, region, city, language, referrer,
  entryPageUrl }` happens **when the snapshot entry is built**, before it can
  ride into `messages.metadata_json`, traces or eval captures via
  `attachContextVariablesToGather` (`chatTurnLifecycle.ts:~374`) — not merely in
  `projectContextForMatching`, which only narrows at match time. `language` is
  the primary tag of `Accept-Language` (structural parse; `de-DE,de;q=0.9` →
  `de`). `clientIp` and `userAgent` never enter the context-variables module; a
  unit test asserts the snapshot entry's key set, and an integration test
  asserts the persisted `metadata_json` contains neither string.
- **FR-032** The variable reaches both classification surfaces (matcher and
  fused planner) via the existing `projectContextForMatching` path — no new
  seam.
- **FR-033** `visitor_request` is unconditional, exactly like `page_context`
  and `visitor_identity`: built-ins have no per-agent enablement row, and a
  toggle reachable only through two API calls would leave the feature unusable
  from the dashboard. The snapshot entry is present whenever the visit carried
  any of the six facts. Operator-declared variables cannot use
  `source: "request"` (rejected like `"browser"`). Docs list the variable and
  its six fields.

### Operator surfaces

- **FR-040** Conversation detail DTO gains `visitor: { id, firstSeenAt,
  conversationCount, verified: boolean } | null` and `requestContext`
  (`clientIp` included; operator-gated as the rest of detail is) and
  `entryReferrer`. Summary DTO gains `visitorCountry: string | null`.
- **FR-041** New operation `GET /api/v1/history/visitors/{visitorId}/conversations`
  (paged summaries, same shape as the history list, excluding a `?exclude=`
  conversation id). Ray coverage map (`catalogCoverage.ts`) maps or excludes it;
  all three OpenAPI copies and the SDK snapshot (`typescript-sdk pnpm run sync`)
  update in the same change.
- **FR-042** Drawer **Visitor** panel replaces the dead `VisitorContextBlock`
  read: country/region/city, browser + OS family (structural UA parse, raw UA in
  a tooltip), language, entry page, referrer, IP, first seen, previous
  conversations (latest five, link to each, "see all N"). Fields with `null`
  render as unknown; the panel renders whenever a conversation has a visitor or
  request context.
- **FR-043** Activity list Source cell shows the country code after the channel
  chip when known. No new column, no filter.
- **FR-044** Visitor-facing payloads (public chat, embed, SDK converse) do not
  gain any of these fields.

### Configuration & docs

- **FR-050** One env var, shared verbatim by both services: `RADIOSO_EDGE_PROOF_SECRET`
  (min 32 chars, optional — unset means an edge marker can never verify). The
  frontend forwards the raw `X-Forwarded-For` chain in the signed envelope
  instead of resolving an address itself, so it needs no proxy-hop or geo-header
  configuration of its own; the backend resolves the trusted client address
  from that chain with its own pre-existing `RADIOSO_TRUSTED_PROXY_HOPS`.
  `docker-compose.yml` / `docker-compose.dev.yml` at repo root set a dev secret
  on both services so the local stack exercises the proof path.
- **FR-051** Docs (following `docs/document-writer-prompt.md`): self-hosting
  env reference; embed docs list what is captured about a visitor; context
  variables doc adds `visitor_request`; privacy/data-handling doc names IP,
  country, user agent, language, referrer, entry page and their retention.
- **FR-052** `docs/architecture/code-map.md` gains the `visitors` module entry.

## Non-goals

- Agent-side memory of previous conversations.
- Visitor facts for MCP-channel conversations (the MCP edge sends a digest, not
  an address, by design) and Slack (the Slack user id could key a visitor later).
- A GeoIP database adapter (the port makes it a composition-only addition).
- Audience Pulse country breakdown, visitor notes/tags/blocklist, a visitors
  list page.
- A conversation delete endpoint or retention automation (none exists today;
  FR-006 records the constraint for whoever adds one).
- The Terraform change that stamps `{client_region}` / `{client_city}` on the
  cloud load balancer — separate PR against `infra/terraform/cdn.tf`, applied
  per region deliberately.

## Key entities

- **Visitor** — a person as far as Radioso can tell: a workspace-scoped row
  keyed by a durable visitor key and/or a host-verified customer id, with
  first/last seen, a conversation count, and the latest observed
  country/language/user agent. Owned by `backend/src/modules/visitors/`.
- **ConversationRequestContext** — edge-observed facts about the request that
  opened a conversation, with provenance (`observedVia`). Contract type in
  `packages/conversation-contract`.
- **Edge facts proof** — HMAC envelope from a first-party edge to the backend,
  built on the generic `@radioso/edge-proof` primitive that the MCP source
  digest proof also moves onto.
- **VisitorGeoResolver** — port from forwarded headers to country/region/city.

## Assumptions

- The frontend proxy is the only first-party edge for browser traffic; API
  clients reach the backend directly. If a second edge appears, it signs with
  the same primitive.
- Load balancers append to `X-Forwarded-For` rather than replace it, so
  caller-supplied prefixes are untrusted; only the last
  `RADIOSO_TRUSTED_PROXY_HOPS` entries are read, and that value is set correctly
  per service (the frontend sits one hop behind the LB; the backend sits one hop
  behind the LB for API clients).
- `visitor_key` is a launcher-persisted `localStorage` value; a visitor who
  clears site data or uses another browser is a new visitor until they verify.
  `anonymous_session_id` keeps its current per-session meaning.
- Storing IP is acceptable under the operator's own terms with their users;
  Radioso documents what is stored and deletes it with the conversation.

## Observability

- Counter `visitor_request_context_observed_total{observedVia}` (three values)
  on conversation creation.
- Counter `edge_facts_proof_rejected_total{reason}` with `reason ∈ {missing,
  expired, signature, malformed}` — no addresses, no headers logged.
- Counter `visitor_identity_attached_total{outcome}` with `outcome ∈ {upgraded,
  moved_existing, moved_new}` for User Story 2 branches.
- Debug-level log on proof rejection carrying only `reason` and the route.
- No spans: the work is synchronous inside the existing turn span; no new
  provider call or queue handoff.

## Success criteria

- Every embed conversation created through the proxied path in the local stack
  records `observedVia = "edge_proof"` with a non-null IP and, with a stubbed
  geo header, a country.
- A visitor who chats twice anonymously then verifies shows as one visitor with
  three conversations in the drawer.
- A contextual directive conditioned on `visitor_request.country` activates in
  the deterministic eval harness with no IP or UA string in the captured trace.
- `pnpm run lint`, `lint:dead-code:ci`, backend unit + integration, frontend
  unit + Playwright drawer journey, SDK snapshot check, and Ray catalog coverage
  all green.
