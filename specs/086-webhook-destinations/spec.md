# Feature Specification: Workspace Webhook Destinations

**Feature Branch**: `routine-webhook-output` (global feature number 086)
**Created**: 2026-06-11
**Status**: Draft (revision 2 — review findings addressed: reference model, https-only, idempotency wording + completion-event identity, signing-is-new, capability-gate resolution)
**Input**: User description: "Build a workspace webhook destinations capability that routines can reference to export their collected slot data on completion. Define named webhook destinations once per workspace; agents reuse them. Generic `webhook.send` capability over the existing action-outbox + SSRF-guarded delivery; the conversation-engine stays destination-agnostic (carries a destination ref + payload only). Design locked in `.context/routine-completion-export-plan.md`."

> **Branch note**: the Speckit `create-new-feature.sh` script normally creates and
> checks out a `086-*` branch. Per explicit requestor instruction this feature stays
> on the pre-existing `routine-webhook-output` branch; the spec lives under
> `specs/086-webhook-destinations/` to preserve global numbering.

## Problem

Routines already collect structured information from visitors (typed slots), but that
data has nowhere to go when the routine finishes — it lives and dies inside the
conversation. Operators want collected data (a captured lead, a support request, a
booking) delivered to their own systems (CRM, ops inbox, automation) the moment a
routine completes.

The naive fix — paste a webhook URL into each routine — does not scale: the same
endpoint gets re-entered across many routines, secrets are smeared across routine
definitions and impossible to rotate in one place, and an inline URL is not an
exportable/re-bindable reference (it breaks settings-as-data import). The fix is a
**named, reusable webhook destination** defined once at the workspace level, which
routines reference by a **stable id** (the human-readable name is a mutable display
label, not the stored reference — see the reference-model contract). The
contact-request webhook that exists today is a hard-coded special case of exactly
this; this feature generalizes it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Define a reusable workspace webhook destination (Priority: P1)

A workspace operator opens workspace settings and defines a named webhook destination
once — e.g. `crm-leads` pointing at their CRM intake URL. The system issues a signing
secret for that destination and shows it once so the operator can configure
verification on their receiving end. The operator can list, rename, update the URL of,
rotate the secret of, and delete destinations. Adding more endpoints means creating
more destinations in the workspace.

**Why this priority**: It is the foundation the whole feature stands on (the registry
and its secret-at-rest handling) and is independently shippable — an operator can
create and manage destinations and verify them with a manual test POST before any
routine references them.

**Independent Test**: In workspace settings, create a destination with a name and a
valid https URL; confirm it is listed and a signing secret is shown once. Edit the URL,
rename it, rotate the secret, then delete the destination. Confirm a non-https URL is
rejected (outside the dev exception) and a duplicate name in the same workspace is
rejected.

**Acceptance Scenarios**:

1. **Given** a workspace with no destinations, **When** the operator creates one with a
   valid name and https URL, **Then** it appears in the workspace destination list and a
   signing secret is displayed exactly once (not retrievable again in plaintext).
2. **Given** an existing destination, **When** the operator edits its URL or rotates its
   secret, **Then** the change persists and the previous secret no longer validates new
   deliveries.
3. **Given** a destination referenced by routines, **When** the operator renames it,
   **Then** the rename succeeds and every referencing routine continues to resolve to the
   same destination (references are by stable id, not by the display name).
4. **Given** an existing destination name in the workspace, **When** the operator tries
   to create another with the same name, **Then** the system rejects it with a clear
   message (names are unique per workspace).
5. **Given** a URL that is not https (and not within the configured local-dev exception)
   or targets a disallowed host, **When** the operator submits it, **Then** the system
   rejects it before saving.
6. **Given** a destination that no routine references, **When** the operator deletes it,
   **Then** it is removed from the workspace.

---

### User Story 2 - A routine exports its collected data on completion (Priority: P1)

An operator authoring a routine enables "on completion, send collected data" and picks
one of the workspace's named destinations from a list (never typing a URL). When a
visitor completes that routine, the data the routine collected (its slot values) is
delivered to the chosen destination as a signed JSON POST, reliably and at-least-once,
without blocking the conversation. The authoring surface shows a live preview of the
payload shape derived from the routine's declared slots.

**Why this priority**: It is the headline value — collected data actually reaching the
operator's system. It depends on US1 (a destination to reference) and delivers the
end-to-end outcome.

**Independent Test**: Define a destination (US1). Author a routine with two slots,
enable completion export to that destination, publish. Drive a conversation through the
routine to a completing terminal. Observe a signed POST arrive at the destination whose
body carries the collected slot values in the previewed shape. Confirm a transient
receiver failure is retried and not silently dropped.

**Acceptance Scenarios**:

1. **Given** a published routine with completion export enabled to destination `D`,
   **When** a visitor reaches a terminal whose kind is in the configured trigger set,
   **Then** a single outbox action (one stable idempotency key) is enqueued and delivered
   to `D` at-least-once, containing the routine's collected slot values, the routine id,
   the terminal step id/kind/status, and conversation correlation; the conversation reply
   is not delayed by the delivery. (Delivery is at-least-once: a receiver timeout may
   produce a duplicate POST carrying the same idempotency key, which the receiver
   de-duplicates — see the delivery contract.)
2. **Given** completion export enabled, **When** the authoring operator views the routine
   editor, **Then** they see a live payload preview generated from the routine's declared
   slots (each slot key with its type), updating as slots are added or removed.
3. **Given** a destination with a signing secret, **When** a delivery is sent, **Then**
   the request carries a signature header the receiver can verify with the shared secret
   and an idempotency key header so redeliveries can be de-duplicated.
4. **Given** the receiver returns a transient error or is unreachable, **When** delivery
   is attempted, **Then** it is retried with backoff up to the configured limit and the
   failure is recorded; the conversation is unaffected.
5. **Given** a routine reaches a terminal whose kind is **not** in the configured trigger
   set (or completion export is disabled), **Then** no delivery is sent.

---

### User Story 3 - References stay safe when destinations change (Priority: P2)

Because routines reference destinations by a stable id (not an inline URL), the
operator is protected from silently breaking a routine. Publishing a routine that references an unknown destination
fails validation with a clear diagnostic. Deleting a destination that published routines
still reference is blocked with a message naming what references it. If a reference ever
dangles at delivery time anyway, the system skips the delivery and records it rather than
crashing the turn or reporting false success.

**Why this priority**: It is the one new failure mode the named-reference model
introduces and must be handled deliberately, not discovered in production. It depends on
US1/US2 existing but is independently testable.

**Independent Test**: Reference a non-existent destination in a routine and attempt to
publish — validation fails with a clear diagnostic. Reference a real destination, publish,
then attempt to delete that destination — deletion is blocked and names the referencing
routine. Force a dangling reference at runtime — the delivery is skipped and logged, the
turn completes normally.

**Acceptance Scenarios**:

1. **Given** a routine referencing a destination id/ref that does not exist in the
   workspace, **When** the operator validates/publishes it, **Then** validation fails with
   a diagnostic identifying the missing reference (surfaced in the routine editor).
2. **Given** a published routine referencing destination `D`, **When** the operator tries
   to delete `D`, **Then** deletion is blocked with a message naming the referencing
   routine(s); deletion succeeds only after the references are removed.
3. **Given** a delivery whose destination reference cannot be resolved at dispatch time,
   **When** the dispatcher processes it, **Then** the delivery is skipped and recorded as a
   degraded outcome (no crash, no retry storm, no false success), without exposing the
   payload.

---

### User Story 4 - Operator can see delivery outcomes (Priority: P3)

An operator can tell whether a destination is actually working: the destination view
shows the last delivery outcome (succeeded / failed) and when, and delivery activity is
countable for operations. Sensitive payload content, URLs, and secrets never appear in
logs or telemetry.

**Why this priority**: Operability of a new outbound runtime path — operators must trust
the webhook is firing — but it is consumed by operators after the core value (US1/US2)
exists.

**Independent Test**: Trigger a successful and a failing delivery; confirm the
destination view reflects each last-outcome and timestamp, and that operational counters
distinguish success/failure/skip without any payload, URL, or secret in the records.

**Acceptance Scenarios**:

1. **Given** deliveries have been attempted to a destination, **When** the operator views
   it, **Then** they see the last delivery outcome and time.
2. **Given** any delivery attempt, **Then** logs and telemetry record outcome and
   correlation only — never the payload contents, the destination URL, or the secret.

#### UI Tasks

- Workspace settings: a destinations management surface — list destinations; create
  (name + https URL, secret shown once); edit URL; rotate secret; delete (blocked when
  referenced, with a clear message). Reuse existing dark-theme settings card patterns and
  the existing webhook-URL validation helper.
- Routine editor: an "On completion" section — enable toggle, a **dropdown of workspace
  destination names** (no raw URL field), trigger-kind selection (`complete` / `handoff`),
  and a **live payload preview** derived from the routine's declared slots. Inline link to
  the destinations surface when none exist yet.
- Destination view shows last delivery outcome + time (US4).
- Cover the payload-preview transform and any list/state transforms with frontend unit
  tests (non-visual); cover the operator journeys (define destination → reference in a
  routine → preview reflects slots → publish; blocked delete) with Playwright.

## Capability Contracts *(mandatory for this feature)*

These contracts are the composability spine. Planning may refine naming/placement but
MUST NOT weaken the responsibility split.

### Reference model: stable id, name is a mutable label (durable decision)

A routine stores a destination's **stable id** (`destinationRef = destination.id`), never
its name or URL. The `name` is a mutable human-readable label used in the UI and as the
import-binding key (below). Consequences, which the implementation MUST honor:

- **Rename is safe**: renaming a destination changes only its label; every routine that
  references it by id keeps resolving to the same destination. No reference rewrite.
- **Settings-as-data import (079) binds by name**: a routine exported from workspace A
  carries the destination's name (a stable, human-meaningful key) alongside its
  source-workspace id. On import into workspace B, the reference re-binds to B's
  destination **with the same name**; if none exists, the import surfaces an unbound
  reference (resolved the same way as a publish-time unknown reference — see Reference
  integrity). This feature builds the id-based runtime reference and the name-based import
  binding rule; it does not build the 079 import flow itself.
- A read API MAY return a destination's current name for display, but resolution and
  validation key off the id.

### Concept split: destination (where) vs. capability (how) vs. routine (what)

- **Webhook destination** — workspace-scoped record: `{ id (stable), name (mutable,
  unique per workspace), url, signingSecret, … }`. Owns *where* data goes and the secret.
  The signing secret is stored encrypted at rest using the existing field-encryption
  convention (`encryptField` / `CONNECTOR_ENCRYPTION_KEY`, as used by `connector_configs` /
  `workspace_provider_credentials`) and is shown in plaintext only once at create/rotate
  time.
- **`webhook.send` capability** — generic action handler. Given a destination *ref* and a
  payload, resolves the destination, signs, and POSTs via the shared SSRF-guarded webhook
  client with idempotency + retries on the existing action-outbox path. Owns *how* data
  goes out. Knows nothing about routines or the engine internals.
- **Routine** — supplies the *what*: its collected slot values. Slots are already typed
  (`text | number | boolean | email | date`), so the slot set IS the payload schema; no
  second schema is authored.

`contact.send` is recognized as a special case of `webhook.send`. This feature MUST NOT
refactor contact onto the generic path, but MUST design the shared delivery helper so
that refactor is possible later without contract changes.

### Engine ↔ delivery responsibility split (engine stays destination-agnostic)

- The conversation engine, when a routine reaches a completion-export-enabled terminal,
  emits a generic action request of type `webhook.send` carrying **only**:
  `{ destinationRef, source: { routineId, stepId, status }, data }` where `data` is built
  from `RoutineState.variables`. The engine MUST NOT know URLs, secrets, HTTP, signing, or
  the registry. It is pure and performs no IO.
- `conversationId` / `workspaceId` / `requestId` are NOT in the engine payload; they come
  from the existing action-handler context attached to the outbox record.
- The backend resolves `destinationRef → { url, secret }` through a narrow resolver port
  (mirroring `ConfiguredContactDeliveryResolver`) and gates on the per-agent capability
  before delivering.

### Delivery contract (`webhook.send` handler)

- **Delivery is at-least-once, not exactly-once.** It rides the existing
  `routine_action_requests` outbox + dispatch worker: retries with backoff up to the
  existing configured limit, lease-based recovery, atomic claim. The outbox guarantees one
  *enqueued action* per completion (via the idempotency key below); it does NOT guarantee a
  single HTTP POST — a receiver timeout after processing can yield a duplicate POST. Both
  POSTs carry the same idempotency key so the receiver can de-duplicate. Specs, docs, and
  tests MUST use "at-least-once / receiver de-dupes," never "exactly one delivery."
- **Idempotency key carries completion-event identity.** The content-addressed key MUST
  incorporate, at minimum: conversation id, action type, destination ref, the completion
  event identity (`routineId` + terminal `stepId` + terminal kind), and the payload hash. A
  routine activation/completion id MUST be included if one exists in routine state.
  **Repeated completions of the same routine in one conversation with identical collected
  data MUST NOT collide on the same idempotency key.** If no existing id distinguishes them,
  the implementation MUST introduce a per-completion identifier (e.g. a completion sequence
  or run id in routine state) — or otherwise demonstrate, with a test, that the chosen key
  components already make repeated completions distinct. A bare hash of stable components
  (routine + step + payload) does NOT satisfy this and is not acceptable on its own.
- **Outbound request**: JSON body; `Idempotency-Key` header; and an HMAC signature header
  (e.g. `X-Radioso-Signature: sha256=…`) computed over the raw body with the destination's
  secret, plus a timestamp header the receiver can use against replay. **Signing is new
  work** — the existing contact webhook path sends no signature (only `Idempotency-Key`);
  this feature introduces the signing scheme and MUST document it with a verification
  example. The shared delivery helper introduced here is what makes signing reusable.
- **Transport security**: destination URLs MUST be **https** and pass SSRF host validation
  at create/edit time and again at delivery time. A non-https URL is rejected, except a
  configuration-gated **local-development exception** (e.g. http to loopback) that MUST be
  off by default and MUST NOT be available in production. SSRF protection reuses the
  existing contact webhook client's behavior (validate every hop including redirects;
  bounded redirects; per-request timeout).

### Per-agent capability gate (open reuse, no allow-list)

- Whether an agent's routines may send webhooks is a single per-agent boolean capability.
  There is NO per-destination allow-list: any routine in the workspace may reference any
  workspace destination. Per-agent destination scoping is explicitly out of scope and MUST
  NOT be built speculatively.
- **Agent resolution for gating**: the action-handler context carries
  `workspaceId`/`conversationId`/`requestId`/`idempotencyKey` but NOT `agentId` (confirmed
  against the contact path). The `webhook.send` resolver MUST therefore resolve the agent
  the same way `ConfiguredContactDeliveryResolver` does — `conversationId + workspaceId →
  agentId` via conversation lookup — then read that agent's webhook capability. This makes
  the gate testable: the resolver port is injectable and the conversation/agent lookups are
  mocked in tests.
- **Denial is a terminal skip, not a retry**: if the capability is disabled, or the agent
  cannot be resolved, the delivery MUST be treated as a degraded **skip-and-record** outcome
  (same class as an unresolvable destination ref — see Reference integrity), NOT a retryable
  failure. A disabled capability must never produce retry churn on the outbox.

### Reference integrity

- **Validate at publish**: publishing a routine that references an unknown destination
  fails validation (diagnostic surfaced in the routine editor's existing diagnostic list).
- **Guard delete**: deleting a destination referenced by any published routine is blocked
  with a message naming the referencing routine(s). (Chosen over soft-delete for clarity;
  see Assumptions.)
- **Runtime safety**: if a reference cannot be resolved at dispatch, the delivery is
  skipped and recorded as a degraded outcome — never a crash, retry storm, or false success.
- This is the same problem class as spec 079's reference re-binding on import; the resolver
  + validation seam built here is the leverage for that.

### Payload shape (v1)

- v1 sends **all** of the routine's collected slot values under `data`. Selecting a subset
  per reference is out of scope (Assumptions). The payload preview in the editor is the
  authoritative description of the shape and is derived from declared slots.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js; frontend in React.
- Database MUST be PostgreSQL with `pgvector` (no new storage system introduced).
- LLM integrations MUST use GPT-5.2 as the default provider. (This feature adds no new
  runtime prompts; if planning finds any, they MUST live under `backend/prompts/`.)
- This feature adds NO user-facing conversational copy generated in code; delivery is a
  background system action, so the multilingual-copy rule is satisfied by not hard-coding
  any assistant strings. Operator-facing UI labels follow normal i18n conventions.
- Backend development MUST follow TDD: tests written and failing before implementation
  (registry, resolver, signing, idempotency, reference integrity, engine emission).
- Frontend user-visible behavior MUST prefer Playwright; frontend unit tests stay focused
  on non-visual logic (payload-preview transform, validation/state helpers) and MUST NOT
  assert markup, class names, or design tokens.
- Secrets/keys MUST live in `.env`; `.env.example` MUST be updated if new configuration is
  introduced. Destination signing secrets are application data and MUST be encrypted at
  rest via the existing field-encryption convention — never stored or logged in plaintext.
- Customer data protection: least-privilege access to destinations and collected data;
  outbound transmission over https with SSRF protection; clear audit trail for destination
  changes; delivery MUST fail safely (degrade, retry, skip) without breaking conversations.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Modular boundaries between transport, orchestration, domain logic, and persistence MUST
  be preserved (see Architecture Constraints).
- **Message-queue / contract impact review**: this feature introduces a new cross-service
  action type (`webhook.send`) on the action-outbox/worker boundary. Planning MUST review
  outbox payload shape, idempotency-key composition, retry/lease semantics, and the
  queue/worker docs and contract tests, and MUST state whether the document-worker dispatch
  is affected (expected: no new AMQP queue; reuses the existing action dispatch worker).
- **Code-first API contracts**: new workspace destination CRUD endpoints MUST be defined in
  the code-first OpenAPI registry with Zod schemas and the generated `openapi.yaml`/`.json`
  regenerated (not hand-edited); contract tests kept aligned.
- **Observability**: the outbound delivery path is a new runtime path and MUST be traceable
  and countable (success / failure / retry / skip) and audit destination changes — without
  recording payloads, URLs, secrets, or credentials.

## Architecture Constraints *(mandatory)*

- **Boundary Rule — engine is destination-agnostic and primary**: the conversation engine
  only ever emits `{ destinationRef, source, data }`. It depends on no registry, transport,
  or secret. Delivery, resolution, and signing are backend concerns invisible to the engine.
- **Boundary Rule — registry is workspace-scoped persistence**: named destinations live in
  a new workspace-scoped table parallel to `connector_configs` / `workspace_provider_credentials`,
  with a focused repository. Secret encryption uses the shared field-encryption helper, not
  a new scheme or a new key.
- **Boundary Rule — generic delivery handler**: a `webhook.send` action handler resolves the
  ref via a narrow resolver port and delivers via a shared SSRF-guarded webhook client. The
  shared client/signing/idempotency logic that contact delivery already needs MUST be
  factored so contact and `webhook.send` do not copy-paste transport (watch the file-count /
  duplication smell), without forcing the contact refactor in this feature.
- **Encapsulation Rule**: the routine runner / engine MUST NOT gain transport, signing, or
  registry knowledge. The chat orchestration / turn lifecycle MUST remain orchestration-only
  — it enqueues actions as it already does for `contact.send` and MUST NOT contain signing,
  resolution, or HTTP. The routine repository owns reference-integrity validation queries,
  not the route handler.
- **Composition**: registering the `webhook.send` handler + resolver is replaceable
  app-wide wiring and MUST be assembled in `backend/src/app/composition/` (mirroring the
  contact routine module), with product rules kept out of composition.
- **New Seams Required**:
  - `workspace_webhook_destinations` table + repository (CRUD, unique name per workspace,
    encrypted secret, reverse-lookup for reference integrity).
  - `WebhookDestinationResolver` port (`resolve(ref, ctx) → { url, secret }`) + capability
    gate, registered in composition.
  - `webhook.send` action type (contract) + `webhookSendActionHandler` + a shared delivery
    helper (SSRF client + signing + idempotency) usable by both contact and webhook.send.
  - Routine definition fields for completion export (`{ enabled, triggerKinds, destinationRef }`),
    engine emission of `webhook.send` on a completion-export terminal, and publish-time
    reference validation.
  - Workspace destinations CRUD HTTP endpoints in the code-first OpenAPI registry.
  - Frontend: workspace destinations management surface; routine-editor completion-export
    section with destination dropdown + slot-derived payload preview.
- **Anti-Goals**:
  - Do NOT let the engine, routine runner, or contract know URLs, secrets, HTTP, or signing.
  - Do NOT store a webhook URL or secret inline in a routine definition.
  - Do NOT build a per-destination allow-list or per-agent destination scoping.
  - Do NOT refactor `contact.send` onto the generic path in this feature (design for it only).
  - Do NOT add mid-flow `webhook`-kind action steps in v1 (completion export only; the engine
    seam must not preclude adding them later).
  - Do NOT add per-routine payload subset selection in v1.
  - Do NOT introduce a new outbound queue; reuse the existing action-outbox dispatch worker.
  - Do NOT converge with the inbound connector contract (connectors are ingestion-only).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST let a workspace operator create, list, edit (name, URL),
  rotate the secret of, and delete named webhook destinations scoped to the workspace.
  Destination names MUST be unique within a workspace.
- **FR-002**: Each destination MUST have a signing secret generated by the system, stored
  encrypted at rest via the existing field-encryption convention, and shown in plaintext
  only once (at create and at rotate). The plaintext secret MUST NOT be retrievable
  afterward, logged, or returned by read APIs.
- **FR-003**: Destination URLs MUST be validated as **https** and host-allowed at
  create/edit time and again at delivery time (SSRF protection consistent with the existing
  contact webhook client: redirect-hop validation, bounded redirects, timeout). Non-https
  URLs MUST be rejected, except a configuration-gated local-development exception that is off
  by default and unavailable in production.
- **FR-004**: A routine MUST be able to declare a completion export referencing a workspace
  destination by its **stable id** (`destinationRef = destination.id`), with a set of
  terminal trigger kinds (`complete` / `handoff`). Routines MUST NOT store the destination's
  name or URL. Renaming a destination MUST NOT change or break any routine's reference.
- **FR-005**: When a routine reaches a terminal whose kind is in its completion-export
  trigger set, the conversation engine MUST emit a generic `webhook.send` action carrying
  `{ destinationRef, source: { routineId, stepId, terminalKind, status }, data }` where
  `data` is the routine's collected slot values; the engine MUST remain free of URLs,
  secrets, HTTP, and registry knowledge.
- **FR-006**: The backend MUST deliver `webhook.send` actions via the existing action-outbox
  and dispatch worker: resolve the destination id, **sign** the body with the destination
  secret (new, verifiable signature header + timestamp — the contact path has no signing),
  include an `Idempotency-Key` header whose key carries completion-event identity
  (conversation, type, destination id, `routineId` + terminal `stepId` + terminal kind,
  payload hash) and MUST distinguish repeated completions of the same routine in one
  conversation — introducing a per-completion id if none exists (see delivery contract),
  proven by test — POST over the https SSRF-guarded client, and retry
  transient failures with backoff up to the existing limit. Delivery MUST be at-least-once
  (receiver de-dupes via the idempotency key) and MUST NOT block or delay the conversation
  turn.
- **FR-007**: Whether an agent's routines may send webhooks MUST be governed by a single
  per-agent boolean capability, resolved at dispatch via conversation→agent lookup
  (`conversationId + workspaceId → agentId`, mirroring the contact resolver) because the
  handler context carries no `agentId`. There MUST be no per-destination allow-list; any
  workspace routine may reference any workspace destination. A disabled capability or an
  unresolvable agent MUST result in a terminal skip-and-record outcome (FR-010), never a
  retryable failure.
- **FR-008**: Publishing a routine that references a destination not present in the
  workspace MUST fail validation with a diagnostic identifying the missing reference.
- **FR-009**: Deleting a destination referenced by any published routine MUST be blocked
  with a message naming the referencing routine(s); deletion succeeds only once no published
  routine references it.
- **FR-010**: If a delivery cannot proceed for a non-transient reason at dispatch time —
  the destination id no longer resolves, the agent cannot be resolved, or the per-agent
  webhook capability is disabled — the system MUST skip the delivery and record a degraded
  outcome (terminal, not retried) — no crash, no false success, no unbounded retry —
  without exposing the payload. Transient transport failures remain retryable (FR-006).
- **FR-011**: The routine editor MUST show a live payload preview derived from the routine's
  declared slots (each slot key with its type), updating as slots change, so operators can
  see exactly what shape will be delivered. v1 delivers all collected slot values.
- **FR-012**: New workspace destination CRUD endpoints MUST be defined in the code-first
  OpenAPI registry with Zod schemas; generated OpenAPI artifacts MUST be regenerated and
  contract tests kept aligned. Read responses MUST NOT include the plaintext secret.
- **FR-013**: Destination changes (create, edit, rotate, delete) MUST produce audit events,
  and delivery attempts MUST be countable (success / failure / retry / skip) and reflected
  as a per-destination last-outcome + time, without recording payloads, URLs, or secrets in
  logs/telemetry/audit detail.
- **FR-014**: The `webhook.send` contract and resolver MUST be designed so `contact.send`
  could later be reimplemented on the same delivery path without contract changes, and so a
  future mid-flow `webhook`-kind action step can emit the same action type — neither is built
  in this feature.

### Key Entities

- **Webhook destination**: workspace-scoped record — `{ id (stable, the reference key),
  workspaceId, name (mutable display label, unique per workspace), url (https),
  signingSecret (encrypted at rest), createdAt, updatedAt, last delivery outcome/time }`.
  Secret shown once. Routines reference the id; rename changes only the label.
- **Webhook delivery action (`webhook.send`)**: outbox record + engine payload —
  `{ destinationRef (= destination.id), source: { routineId, stepId, terminalKind, status },
  data }`; correlation (`workspaceId`/`conversationId`/`requestId`) supplied by handler
  context; idempotency key derived from conversation + type + destination id + completion-event
  identity (routineId + terminal stepId + terminal kind + completion id where available) +
  payload hash.
- **Routine completion export config**: per-routine — `{ enabled, triggerKinds:
  ("complete" | "handoff")[], destinationRef }`.
- **Per-agent webhook capability**: boolean gate — may this agent's routines send webhooks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can define a reusable workspace destination and reference it from
  multiple routines without re-entering the URL or secret — the same destination drives
  more than one routine in tests.
- **SC-002**: When a visitor completes a routine with export enabled, the collected slot
  values arrive at the destination as a signed POST whose body matches the editor's payload
  preview, verified end-to-end in tests; the conversation reply is not delayed by delivery.
- **SC-003**: Receivers can verify authenticity: a delivery's signature validates against the
  destination secret in a test, and a tampered body fails verification.
- **SC-004**: Delivery is reliable (at-least-once): a transient receiver failure is retried
  and eventually succeeds (or is recorded failed after the limit); every attempt for the same
  completion carries the same idempotency key so a receiver can collapse duplicates to one,
  verified in tests. A disabled-capability or unresolvable-reference delivery is skipped
  terminally with no retry churn.
- **SC-005**: Reference integrity holds: publishing a routine with an unknown destination
  fails validation; deleting an in-use destination is blocked naming the referencing
  routine; a forced dangling reference at dispatch is skipped-and-recorded — all verified in
  tests with the conversation unaffected.
- **SC-006**: No secret or payload leakage: in tests, read APIs never return the plaintext
  secret, and logs/telemetry/audit for deliveries contain no payload, URL, or secret.
- **SC-007**: Zero behavior change for routines without completion export and for the
  existing `contact.send` path: their test suites pass unchanged.
- **SC-008**: One activation/turn cost is unchanged — emitting a completion webhook adds no
  synchronous LLM or network round-trip to the visitor-facing turn (delivery is async via the
  outbox), verified by the turn not awaiting delivery.

## Assumptions

- **Scope (locked)**: workspace-scoped destination registry; open reuse with a single
  per-agent on/off capability; no per-destination allow-list.
- **Reference model (decision)**: routines reference a destination by **stable id**; the
  name is a mutable label. Rename is safe; settings-as-data import re-binds by name. (Resolves
  the earlier "by name vs stable ref" inconsistency.)
- **Transport (decision)**: destinations are **https-only**, with an off-by-default,
  not-in-production local-dev exception for loopback http. Collected slot data is customer
  data and must transit securely.
- **Signing (decision)**: each destination has a system-generated secret; deliveries are
  signed (HMAC over raw body, verifiable header + timestamp). Secret encrypted at rest via
  the existing `encryptField` / `CONNECTOR_ENCRYPTION_KEY` convention. Signing is **new
  work** (the contact path is unsigned); the shared delivery helper introduced here is what
  makes it reusable.
- **Idempotency (clarification)**: delivery is **at-least-once**; the idempotency key
  guarantees one enqueued action per completion and lets receivers de-duplicate redeliveries.
  The key includes completion-event identity and a per-completion distinguisher so two
  legitimate completions of the same routine in one conversation cannot collide (introduce a
  completion/run id if none exists; prove non-collision by test — a bare stable-component
  hash is not acceptable alone).
- **Payload (decision)**: v1 delivers all collected slot values; per-reference subset
  selection is deferred.
- **Trigger surface (decision)**: completion export ships first; mid-flow `webhook`-kind
  action steps are deferred but the engine seam must not preclude them.
- **Destination delete (decision)**: hard-block when referenced by a published routine, with
  a clear message; soft-delete considered and not chosen (clearer operator model, simpler
  reference semantics).
- **Contact reuse (decision)**: `contact.send` is a special case; this feature factors a
  shared delivery helper but does not refactor contact onto it.
- **Reuse of existing infra**: existing action-outbox table, dispatch worker, SSRF-guarded
  webhook client, idempotency, retry/lease semantics, and field-encryption helper are
  present and reused; no new queue is introduced.

## Dependencies

- Action-outbox table (`routine_action_requests`) + dispatch worker with retries, lease
  recovery, atomic claim, content-addressed idempotency — present.
- SSRF-guarded webhook client + idempotency-key handling from the contact delivery path —
  present; to be factored for reuse. **Signing is NOT present** — the contact path sends no
  signature (`contactSendActionHandler.ts`); the HMAC signing scheme is new work in this
  feature.
- Field-encryption convention (`encryptField` / `decryptField`, `CONNECTOR_ENCRYPTION_KEY`)
  used by `connector_configs` / `workspace_provider_credentials` — present.
- Routine definition, compiler, runner, terminal kinds, and `RoutineState.variables` (082 /
  routines-as-data) — present.
- Per-agent capability + composition registration pattern (contact routine module) — present.
- Code-first OpenAPI registry + audit-event + trace infrastructure — present.

## Delivery Phasing *(informative — not a substitute for plan.md)*

The feature is delivered in independently verifiable phases; each phase is verified before
the next begins:

1. **Registry + resolver + reference integrity** (US1 backend; US3 backend): table,
   repository, encrypted secret, CRUD endpoints + OpenAPI, resolver port, publish-time
   validation, delete guard. TDD + docs.
2. **`webhook.send` handler + composition + signing** (US2 delivery; US3 runtime skip):
   shared delivery helper, handler, signing, idempotency over the outbox, capability gate.
   Integration tests + docs.
3. **Contract + engine emission** (US2 engine): `webhook.send` contract, routine
   completion-export fields, engine emits on configured terminals. Unit tests.
4. **Frontend** (US1 UI, US2 UI): workspace destinations management surface; routine-editor
   completion-export section with destination dropdown + live slot payload preview.
   Playwright + non-visual unit tests.
5. **Observability / audit polish** (US4): last-outcome surfacing, counters, audit — folded
   into phases 1–2 where natural.
