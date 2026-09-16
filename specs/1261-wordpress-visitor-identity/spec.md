# Feature Specification: WordPress signed visitor identity and WooCommerce customer context

**Feature Branch**: `1261-wordpress-visitor-identity`
**Created**: 2026-09-16
**Status**: Draft
**Issue**: #1261
**Input**: A WooCommerce shop wants the embedded agent to know who the logged-in customer is — name, email, recent orders — so answers are personalised.

## Why this exists

Radioso already has the two primitives this needs: `customer`-scoped context
variables (pushed by a host backend, resolved `session -> customer -> agent ->
workspace`) and signed visitor identity (an HMAC token the embed sends with each
message, verified against the public chat session, the embed origin, a
five-minute `issuedAt` window and a single-use nonce). What is missing is the
WordPress side of both: nothing mints the token for a logged-in WP user, and
nothing pushes WooCommerce facts into the customer scope.

The launcher half — `window.Radioso.identify` accepting an async **provider**
that the embed calls per message with `{ sessionId, origin }` — ships separately
from this spec. This spec assumes it and builds the WordPress end.

## Boundaries (what each part knows)

| Part | Knows | Must not know |
|------|-------|---------------|
| Radioso Sync plugin (PHP, `packages/wordpress-companion/radioso-sync.php`) | WP user session, WooCommerce orders, the agent signing key, a workspace API token, the Radioso API base URL | Anything about how Radioso resolves or surfaces context; the token format beyond the documented payload |
| Enqueued page script (JS, shipped by the plugin) | That `window.Radioso.identify` accepts a provider; the plugin's REST route | WP auth internals — it only calls a same-origin endpoint with cookies |
| Radioso embed launcher + frame | Public session id, host origin, when a message is about to be sent | Who the customer is; WordPress |
| Radioso backend | Token verification, `customer` scope, variable catalog | WordPress, WooCommerce order shapes (it stores `json`) |

Dependency direction: plugin → Radioso public API. Radioso gains no WordPress
knowledge. The plugin is the only new code; no backend change is required for
the core flow.

## User Scenarios & Testing

### User Story 1 — Logged-in shopper is recognised (Priority: P1)

A shopper signed in to the WooCommerce store opens the chat and asks "where is
my order?". The agent answers about *their* latest order without asking who they
are.

**Why this priority**: it is the whole point; without identity, nothing else in
this spec is reachable.

**Independent test**: with the plugin configured, sign in as a WP customer,
open the embed, send one message. In the Radioso Inbox the turn's **Visitor
context** block shows `visitor_identity` as verified with the WP user id as
`customerId`, and the conversation is tagged with that customer.

**Acceptance scenarios**:

1. **Given** a signed-in WP user and a configured plugin, **when** the embed
   sends a message, **then** the plugin's identity endpoint returns a token whose
   `sessionId` and `origin` match the session, and Radioso records a verified
   identity on that turn.
2. **Given** an anonymous visitor, **when** the embed sends a message, **then**
   the endpoint returns `204` and the turn proceeds anonymous — no error is
   shown, nothing is logged at warn level.
3. **Given** a signed-in user whose session has been open for more than five
   minutes before the first message, **when** they send it, **then** identity
   still verifies (the token is minted per message, at the moment of use).
4. **Given** a shopper who signs out mid-conversation, **when** they send the
   next message, **then** the endpoint returns `204`, the turn carries no new
   identity, and the conversation keeps its already-recorded customer id (this
   is existing backend behaviour: `verifiedCustomerId` persists on the
   conversation once set; the spec does not attempt to un-identify).

### User Story 2 — Customer facts reach the agent (Priority: P1)

The agent can see the shopper's name, email and recent orders as context.

**Why this priority**: identity alone unlocks the `customer` scope; the facts are
what make the answer useful.

**Independent test**: push a customer profile and orders for WP user 42, sign in
as user 42, ask "what did I order last?" — the answer names the order. Ask the
same as an anonymous visitor — the agent has no such context.

**Acceptance scenarios**:

1. **Given** a WP user logs in, **when** `wp_login` fires, **then** the plugin
   pushes `customer_profile` (customer scope, id = WP user id) with `{ name,
   email, since }`.
2. **Given** an order changes status (`woocommerce_order_status_changed`) or is
   placed (`woocommerce_thankyou`), **when** the hook fires, **then** the plugin
   pushes `recent_orders` for that order's customer: the N most recent orders
   (default 5), each `{ id, number, date, status, total, currency, items:
   [{ name, sku, quantity }] }`.
3. **Given** the order push fails (Radioso unreachable), **when** the hook
   fires, **then** the checkout is not delayed or failed — the push is
   non-blocking with the same 5-second timeout the content webhook uses, and the
   failure is logged to the plugin's existing log.
4. **Given** a shopper with no orders, **then** `recent_orders` is pushed as an
   empty list rather than left unset, so the agent can say so instead of
   guessing.

### User Story 3 — Operator sets it up in minutes (Priority: P2)

An operator with an existing Radioso Sync install enables identity without
writing code.

**Independent test**: a fresh WP site with the plugin; follow the doc; complete
US1 and US2 within one sitting.

**Acceptance scenarios**:

1. **Settings → Radioso Sync** gains an **Identity** section: Radioso API base
   URL, workspace API token, agent id, agent signing key. Saving with the key
   present enqueues the identity script on every front-end page where the
   embed script is present.
2. A **Test identity** button on the settings page signs a dummy payload and
   shows the resulting token's decoded payload (never the key), so a
   misconfigured key or origin is visible before customers hit it.
3. The context variable declarations (`customer_profile`, `recent_orders`) are
   created by the operator in Radioso per the docs; the plugin resolves their
   ids by name via `GET /api/v1/context-variables` on save and caches them. A
   missing declaration is surfaced on the settings page, not at push time.

## Functional Requirements

### Identity endpoint

- **FR-001** `GET /wp-json/radioso/v1/identity?session=<publicSessionId>`,
  cookie-authenticated (`credentials: 'same-origin'`), with the standard WP REST
  nonce (`X-WP-Nonce`) so a cross-site page cannot mint tokens for a logged-in
  user.
- **FR-002** Signed-in user → `200 text/plain` with the token
  `base64url(payload) + "." + base64url(HMAC_SHA256(keyBytes, base64url(payload)))`.
  The key is the hex string from `GET /api/v1/agents/{agentId}/context-variables/signing-key`,
  decoded to bytes before use.
- **FR-003** Payload: `{ customerId: "<wp_user_id>", sessionId, origin, issuedAt:
  <ms epoch>, nonce: <128-bit random, base64url>, attributes: { name, email } }`.
  `origin` is the request's own site origin (`home_url()` scheme+host+port),
  not a value read from the query string — the embed's origin binding is the
  host page, which is this site.
- **FR-004** Anonymous request → `204`, no body. Missing/invalid `session` →
  `400`.
- **FR-005** The endpoint is `Cache-Control: no-store` and never logs the token,
  key, or payload.

### Page script

- **FR-006** When the identity section is configured, the plugin enqueues a
  small script after the Radioso embed script that registers:

  ```js
  window.Radioso.identify(async ({ sessionId, origin }) => {
    const res = await fetch(`${restRoot}radioso/v1/identity?session=${encodeURIComponent(sessionId)}`,
      { credentials: 'same-origin', headers: { 'X-WP-Nonce': wpNonce } })
    return res.status === 200 ? res.text() : null
  })
  ```

  `origin` from the provider is ignored by the script (the endpoint derives it)
  but the shape is kept so the same script works if that changes.
- **FR-007** If `window.Radioso` is not present when the script runs, it
  registers on `DOMContentLoaded` and gives up silently after that — the embed
  may be disabled on this page.

### Context push

- **FR-008** Pushes use `PUT /api/v1/context-variables/{id}/values` with
  `{ scope: { type: "customer", id: "<wp_user_id>" }, data }` and the workspace
  API token as a bearer.
- **FR-009** `customer_profile` is pushed on `wp_login` and on
  `profile_update`. `recent_orders` is pushed on `woocommerce_thankyou`,
  `woocommerce_order_status_changed`, and on `wp_login` (so a returning
  customer's orders are fresh even if no order event fired since the plugin was
  installed).
- **FR-010** Pushes go through the existing queue-and-flush-on-`shutdown`
  mechanism so a request that triggers several hooks makes at most one push per
  variable.
- **FR-011** Guest orders (no WP user) are not pushed; identity cannot be
  proven for a guest, so a customer scope would never resolve.
- **FR-012** The plugin never pushes payment details, addresses beyond
  country, or anything the operator has not enabled. `email` is pushed only
  when the operator ticks **Include email** (default on); the doc tells them to
  mark the Radioso declaration `sensitive`.

### Settings & docs

- **FR-013** New options: `radioso_api_base_url`, `radioso_api_token`,
  `radioso_agent_id`, `radioso_signing_key`, `radioso_identity_include_email`,
  `radioso_recent_orders_count`. Secrets are stored like the existing shared
  secret (same sanitisation, never echoed back in full).
- **FR-014** `docs-portal/content/operators/wordpress-connector.mdx` gains a
  "Know your logged-in customers" section: the two variables to declare (name,
  type `json`, trust `signed`, sensitivity), the agent Context wiring, the
  settings to fill, and the Inbox check. `context-variables.mdx` links to it as
  the worked example of the provider form.
- **FR-015** The `radioso-sync.zip` served from the dashboard is rebuilt from
  the updated plugin.

## Non-goals

- **Personalised greeting.** The bootstrap greeting request does not carry or
  verify identity, so the first assistant line cannot use the customer's name.
  That is a backend change (verify identity on `startConversation`) and is out
  of scope; record it as a follow-up issue when this ships.
- **Un-identifying a conversation** after logout (see US1.4).
- **Order actions** (cancel, reship). This spec is read-only context; actions
  belong to a skill.
- **Non-WooCommerce commerce plugins.** Hooks are WooCommerce-specific; the
  identity half is generic WordPress and works without WooCommerce.

## Key entities

- **Identity token** — see FR-002/FR-003; lifetime five minutes, single use.
- **`customer_profile`** — `{ name: string, email?: string, since: ISO date }`,
  scope `customer`.
- **`recent_orders`** — `{ orders: [...], count: number, updatedAt: ISO }`,
  scope `customer`.

## Assumptions

- The host page origin the embed bound at bootstrap equals `home_url()` origin.
  Multisite or a shop served from a different origin than `home_url()` is
  unsupported in v1 and called out in the doc.
- The per-agent signing key is revealed only from a signed-in dashboard session
  (API tokens cannot read it); the operator pastes it into WP once. Key rotation
  is a manual re-paste; Radioso accepts the current and previous key, so the
  window is graceful.
- Operators already run the Radioso Sync plugin for content; identity is an
  additive section, not a second plugin.

## Observability

Plugin side: identity endpoint outcomes (`200`/`204`/`400`) and push
success/failure counts land in the existing plugin log at info/warn, without
token, key, email, or order contents. Radioso side needs nothing new: failed
verification already falls back to anonymous and the Inbox already shows the
redacted visitor context block.

## Success criteria

- **SC-001** A signed-in WooCommerce customer's first message in a fresh
  session is a verified turn (Inbox shows `visitor_identity` verified) in ≥ 99%
  of attempts on a healthy site.
- **SC-002** An operator following the doc reaches US1 + US2 in under 20
  minutes on a stock WordPress + WooCommerce install.
- **SC-003** Checkout time is unaffected (push is non-blocking, ≤ 5 s timeout,
  measured as no p95 regression on `woocommerce_thankyou`).
