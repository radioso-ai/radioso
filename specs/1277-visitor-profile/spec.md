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

The two primitives that exist — a browser cookie (`anonymous_session_id`,
30 days) and a host-signed customer id (`verified_customer_id`) — are the right
raw material; what is missing is the entity that joins them and the request
facts that describe each visit.

## Boundaries (what each part knows)

| Part | Knows | Must not know |
|------|-------|---------------|
| Frontend proxy routes (`frontend/app/api/public/chat/[token]`, `frontend/app/api/embed/session/[token]`) | The client-facing request: socket/LB-forwarded address, geo headers the load balancer stamped, `User-Agent`, `Accept-Language`; the edge signing secret | What Radioso does with the facts; visitors; conversations |
| `@radioso/mcp-source-proof` (edge proof primitive) | How to sign and verify a canonical payload bound to method, path and time | The meaning of any field it signs |
| `VisitorGeoResolver` port + header adapter (composition) | Which forwarded header carries country/region/city and in what precedence | Conversations, visitors, the drawer |
| `visitors` module (`backend/src/modules/visitors/`) | Identity resolution rules (verified beats cookie, cookie upgrades to verified, never re-attach a cookie to a second verified id), the `visitors` table | HTTP, headers, geo, the LLM |
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
   for this product class. Retention follows the conversation: deleting the
   conversation deletes the facts; a `visitors` row with no remaining
   conversations is deleted with the last one. Privacy docs name the fields.
2. **Previous conversations are operator-only** in this spec. Agent-side
   cross-conversation memory (summaries injected into the next conversation) is
   a separate feature with its own identity-strength question.
3. **Edge facts travel in a signed envelope, not by proxy-hop counting.** Two
   ingress paths reach the backend (LB → backend for API clients; LB → frontend
   proxy → backend for the embed), so a single `trusted hops` number cannot be
   right for both. The frontend proxy signs what it observed with a shared
   secret, reusing the canonical-payload signing already in
   `@radioso/mcp-source-proof`. That package deliberately returns only an
   address *digest* for rate limiting; this spec adds a sibling envelope that
   carries the address, under a distinct proof context, and does not change the
   digest path.
4. **Country comes from a header the load balancer stamps**, resolved through a
   port. Cloud: GCP `{client_region}` / `{client_city}` custom request headers on
   `google_compute_backend_service.frontend_app` (`infra/terraform/cdn.tf`) —
   a separate infra PR, because live/live-eu applies are drift-sensitive. Self-
   hosted: Cloudflare (`CF-IPCountry`) and similar well-known headers work with
   no configuration; anything else is one env var. No GeoIP database ships.
5. **A `visitors` entity exists** rather than a derived query over two string
   columns, because this is the moment it earns its keep: one join for previous
   conversations, one place the drawer reads, a merge point when a cookie visitor
   verifies, and a single deletion target.

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
4. **Given** a second conversation from the same browser cookie, **when** the
   operator opens either, **then** the other appears under "Previous
   conversations" with title, date and agent.
5. **Given** a conversation with `purpose = operator_test`, **when** it is
   created, **then** no visitor is created or updated.

### User Story 2 — A cookie visitor becomes a known customer (Priority: P1)

A shopper chats anonymously twice, then logs in to the store; the host now mints
a signed identity (`verified_customer_id`). From that turn on, the operator sees
one visitor with three conversations, not two strangers and a customer.

**Independent test**: create two conversations with cookie A; on the third,
send a verified identity token for customer C; the `visitors` row for A now has
`verified_customer_id = C`, and all three conversations resolve to it.

**Acceptance scenarios**:

1. **Given** a visitor row keyed only by cookie A, **when** a turn on any of its
   conversations verifies customer C and no row for C exists, **then** the row
   gains `verified_customer_id = C`.
2. **Given** a row for cookie A and a separate row for customer C, **when** a
   turn on A's conversation verifies C, **then** the conversation moves to C's
   row and A's row is unchanged (a shared browser, second account).
3. **Given** a row for cookie A already bound to customer C, **when** a turn on
   A's conversation verifies customer D, **then** the conversation moves to a
   row for D; A's row keeps C and the cookie is not re-attached.
4. **Given** two first messages from a brand-new cookie arriving concurrently,
   **when** both create conversations, **then** exactly one `visitors` row
   exists and both conversations point at it.

### User Story 3 — Directives react to where the visitor is (Priority: P2)

An operator writes a contextual directive "when the visitor is in Germany,
mention that shipping to the EU takes 3–5 days". A visitor from Berlin asks
about delivery; the directive activates.

**Independent test**: enable `visitor_request` on the agent, add the directive,
send a message with the geo header stubbed to `DE`; the turn trace shows the
directive matched and the redacted snapshot shows `visitor_request.country =
"DE"` with no IP or user agent anywhere in the trace.

**Acceptance scenarios**:

1. **Given** `visitor_request` enabled, **when** a turn runs, **then** the
   match projection carries `{ country, region, city, language, referrer,
   entryPageUrl }` and nothing else.
2. **Given** `visitor_request` not enabled on the agent, **when** a turn runs,
   **then** the variable is absent from the snapshot (same enablement rule as
   the other built-ins).
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
  cascade, `anonymous_session_id text null`, `verified_customer_id text null`,
  `first_seen_at`, `last_seen_at`, `conversation_count int`, `last_country
  text null`, `last_language text null`, `last_user_agent text null`) with
  unique partial indexes on `(workspace_id, anonymous_session_id)` and
  `(workspace_id, verified_customer_id)`, and `conversations.visitor_id uuid
  null` fk (`ON DELETE SET NULL`) with an index. Both `db:types` and
  `db:schema` snapshots regenerate.
- **FR-002** The same migration backfills: one row per distinct
  `(workspace_id, verified_customer_id)`, then one per distinct
  `(workspace_id, anonymous_session_id)` not already covered by a conversation
  that has a verified id; `visitor_id` set on every `production` conversation
  with either key; counts and first/last seen derived from `created_at`.
- **FR-003** `VisitorResolver.resolveForConversation({ workspaceId,
  anonymousSessionId, verifiedCustomerId, observed: { country, language,
  userAgent } })` returns a `visitorId`, applying: verified id first; else
  cookie; else insert. Insert uses `ON CONFLICT DO NOTHING` and re-selects.
  Updates `last_seen_at`, `conversation_count`, and the `last_*` observations.
- **FR-004** `VisitorResolver.attachVerifiedIdentity({ conversationId,
  verifiedCustomerId })` runs wherever `setVerifiedCustomerId` runs today
  (`chatSessionPreparer.ts` first verified turn), applying the rules of User
  Story 2 and re-pointing `conversations.visitor_id` when the conversation moves.
- **FR-005** Conversations with `purpose = operator_test` never touch
  `visitors`. Conversations with neither key (Slack, MCP without a session) get
  `visitor_id = null`.
- **FR-006** Deleting a conversation decrements `conversation_count`; a visitor
  reaching zero is deleted in the same repository operation. Workspace deletion
  cascades.

### Request facts

- **FR-010** `packages/conversation-contract` gains
  `ConversationRequestContext { clientIp, country, region, city, userAgent,
  acceptLanguage, observedVia: "edge_proof" | "backend" | "unproven" }` (all
  strings nullable, `userAgent` capped at 512 chars, `acceptLanguage` at 256);
  migration adds `conversations.request_context jsonb null` and
  `conversations.entry_referrer text null`.
- **FR-011** `request_context` and `entry_referrer` are set once at conversation
  creation, next to `entry_page_url`, and never overwritten.
- **FR-012** `ConversationRepositoryPort.create` takes a single typed input
  object (replacing the seven positional parameters plus options bag) that
  includes `visitorId`, `requestContext`, `entryReferrer`. Extraction of the
  signature change lands before the behaviour change.
- **FR-013** `entry_referrer` is client-claimed: the launcher sends
  `document.referrer` of the host page alongside `pageUrl` in the bootstrap page
  context. It lives next to `entry_page_url`, not inside `request_context`,
  because the two have different trust.

### Edge proof

- **FR-020** `@radioso/mcp-source-proof` gains `createEdgeFactsProof` /
  `verifyEdgeFactsProof` under proof context `radioso:edge-facts:v1`: payload =
  `{ clientIp, geoHeaders: Record<string,string>, userAgent, acceptLanguage }`,
  canonicalised deterministically, bound to method + path + timestamp, 60 s
  window, HMAC-SHA256 with `RADIOSO_EDGE_PROOF_SECRET`. Existing digest exports
  are untouched.
- **FR-021** The two frontend proxy routes always send `x-radioso-edge:
  frontend`; when the secret is configured they also send the proof headers.
  The client address at the edge is resolved from the LB-appended
  `X-Forwarded-For` suffix using `RADIOSO_TRUSTED_PROXY_HOPS` semantics (same
  suffix rule as `resolveSourceDigest`, returning the address), falling back to
  the socket address.
- **FR-022** `geoHeaders` at the edge = the well-known set (`x-client-region`,
  `x-client-city`, `cf-ipcountry`, `x-appengine-country`, `x-vercel-ip-country`,
  `x-vercel-ip-country-region`, `x-vercel-ip-city`) plus the value of
  `VISITOR_GEO_COUNTRY_HEADER` / `VISITOR_GEO_REGION_HEADER` /
  `VISITOR_GEO_CITY_HEADER` when set. Header names are protocol identifiers, not
  product vocabulary.
- **FR-023** Backend public chat routes derive `ConversationRequestContext`:
  valid proof → `observedVia: "edge_proof"`, facts from the payload; marker
  without valid proof → all facts `null`, `observedVia: "unproven"`; no marker →
  `observedVia: "backend"`, IP from socket/trusted suffix, `geoHeaders` from
  the request's own headers. A spoofed marker can only hide a caller, never
  forge facts.
- **FR-024** `VisitorGeoResolver.resolve(geoHeaders) → { country, region, city
  }` is a port; the header adapter applies precedence override → GCP →
  Cloudflare → Vercel → App Engine, normalises country to upper-case ISO
  3166-1 alpha-2, and returns `null` for anything else. Wired in composition.

### Context variable

- **FR-030** `ContextVariableSource` gains `"request"`; registry gains
  `visitor_request` (`source: "request"`, `valueType: "json"`, `surfacing:
  "always"`, `trustTier: "unverified"`, `sensitivity: "normal"`).
- **FR-031** Its value is projected from the conversation record as `{ country,
  region, city, language, referrer, entryPageUrl }` where `language` is the
  primary tag of `Accept-Language` (structural parse; e.g. `de-DE,de;q=0.9` →
  `de`). `clientIp` and `userAgent` are never included; a unit test asserts the
  projection's key set.
- **FR-032** The variable reaches both classification surfaces (matcher and
  fused planner) via the existing `projectContextForMatching` path — no new
  seam.
- **FR-033** Settings UI and docs list the new source and variable; the
  agent-level enablement toggle works like the other built-ins.

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

- **FR-050** Backend env: `RADIOSO_EDGE_PROOF_SECRET` (min 32 chars, optional),
  `VISITOR_GEO_COUNTRY_HEADER` / `_REGION_HEADER` / `_CITY_HEADER` (optional).
  Frontend env: the same four names. `docker-compose.yml` / `docker-compose.dev.yml` at repo root set a dev
  secret so the local stack exercises the proof path.
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
- Retention automation beyond conversation-follows-deletion.
- The Terraform change that stamps `{client_region}` / `{client_city}` on the
  cloud load balancer — separate PR against `infra/terraform/cdn.tf`, applied
  per region deliberately.

## Key entities

- **Visitor** — a person as far as Radioso can tell: a workspace-scoped row
  keyed by a browser cookie and/or a host-verified customer id, with
  first/last seen, a conversation count, and the latest observed
  country/language/user agent. Owned by `backend/src/modules/visitors/`.
- **ConversationRequestContext** — edge-observed facts about the request that
  opened a conversation, with provenance (`observedVia`). Contract type in
  `packages/conversation-contract`.
- **Edge facts proof** — HMAC envelope from a first-party edge to the backend,
  sibling of the MCP source digest proof.
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
- `anonymous_session_id` remains a 30-day cookie; a visitor who clears it is a
  new visitor until they verify.
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
