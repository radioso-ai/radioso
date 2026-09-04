# Research: Operator MCP With Delegated OAuth

## Decision 1: Keep operator OAuth inbound and isolated

**Decision**: Add an `operatorMcp` backend module for inbound authorization and
grant lifecycle. Do not reuse the outbound `integrationOauth` domain or any
ordinary API, personal, service-account, agent-channel, public-chat, or embed
credential.

**Rationale**: Those credentials have different subjects, audiences, revocation
rules, and trust boundaries. A dedicated module can enforce the approved
one-user/one-workspace/one-client grant and continuous-membership tenure.

**Alternatives considered**: Reusing integration OAuth would invert its client
role; reusing personal tokens would omit consent, narrow scopes, and client
attribution; extending agent-channel credentials would couple operator roles to
the single-agent surface.

## Decision 2: Opaque credentials with PostgreSQL authority

**Decision**: Authorization codes, access tokens, and refresh tokens are
cryptographically random opaque values. Only SHA-256 digests are persisted.
PostgreSQL transactions own one-time code consumption, refresh rotation/replay,
grant versioning, revocation, cost reservation, and operation reconciliation.

**Rationale**: Every protected request must observe current grant, membership,
role, and deployment state. Opaque credentials force validation against the
authoritative record and make immediate multi-instance revocation straightforward.

**Alternatives considered**: Self-contained JWT access tokens would still need
an authoritative lookup and add signing-key/claim complexity. Redis-only state
would contradict PostgreSQL as the system of record and make restore behavior
harder to reason about.

## Decision 3: Short-lived service-authenticated internal proofs

**Decision**: The standalone MCP service presents the raw OAuth access token
only to a backend validation endpoint. The endpoint creates a single-use,
short-lived HMAC-authenticated proof bound to resource, grant, invocation,
method, and optional descriptor. The standalone service sends that proof to
the internal catalog or invocation endpoint; the backend atomically consumes
it and repeats authoritative authorization.

**Rationale**: This preserves the standalone protected-resource topology while
preventing OAuth bearer credentials from becoming general backend credentials.
Persisted invocation admission supplies replay resistance across replicas.

**Alternatives considered**: Passing the bearer to product APIs violates the
approved boundary. Mutual TLS would add deployment-wide certificate lifecycle
outside the existing stack. A reusable service token would not bind a call to
the validated human grant or invocation.

## Decision 4: One production catalog, explicit MCP dispositions

**Decision**: Extend `CopilotToolDescriptor` with a required `mcp` disposition:
either an eligible declaration with fixed scope, context strategy, retry/effect
semantics, and adapter metadata, or an excluded declaration with a non-empty
reason. A machine-checked catalog gate accounts for every first-party and
contributed production descriptor. MCP maps eligible descriptors generically.

**Rationale**: The existing catalog already owns schemas, permissions, shapes,
cost, provenance, bounded outputs, and tool factories. A required disposition
prevents accidental exposure when a descriptor is added.

**Alternatives considered**: A copied MCP catalog would drift. A name allowlist
would not review input context, retries, or effects. Treating every descriptor
as eligible would expose dashboard-context assumptions and unsafe acts.

## Decision 5: Limited rollout admits a deliberate vertical slice

**Decision**: The initial enabled catalog proves one context-free read
(`workspace_settings`), one explicit-input probe (`retrieval_probe`), and one
conversation-independent proposal (`propose_ingestion_settings`). All acts and
other descriptors begin with reviewed exclusions. The GA act gate remains
closed until an owning module separately approves a named act and its queue,
retry, reconciliation, and client fixtures pass.

**Rationale**: This is enough to prove discovery, permission intersection,
budgeting, bounded customer-data return, proposal provenance, and dashboard
review without pretending current stateful descriptors are retry-safe.

**Alternatives considered**: Exposing all reads/proposals greatly increases the
review surface. Selecting `set_triage_state`, reprocessing, recrawling, or eval
mutation without owner-backed semantics would violate FR-023 and FR-038.

## Decision 6: Transport-neutral proposal origin

**Decision**: Add an `operator_mcp_invocations` record and allow a proposal to
reference exactly one of `conversation_id` or `operator_mcp_invocation_id`.
Change the copilot proposal contract to a discriminated `origin`. Existing
dashboard creation remains conversation-backed; the eligible MCP proposal is
invocation-backed. Proposal review/apply/dismiss continues through the existing
session-authenticated service and card.

**Rationale**: This preserves proposal semantics without fabricating a Ray
conversation or weakening ownership.

**Alternatives considered**: Synthetic conversations pollute history and
retention. A second proposal store would duplicate optimistic guards and apply
rules. Making all proposal call sites nullable without a discriminant would
allow invalid origin combinations.

## Decision 7: Client metadata fetches reuse the public-URL security seam

**Decision**: Resolve Client ID Metadata Documents through a bounded adapter
built on the existing public URL/DNS-pinning infrastructure. It allows HTTPS
only, manually validates every redirect, rejects private/reserved addresses,
pins DNS at connect time, caps time/bytes/hops, and stores only validated fields
and their digest for the transaction.

**Rationale**: Client metadata is attacker-controlled URL input and has the
same SSRF/rebinding boundary as existing protected public fetches.

**Alternatives considered**: A plain `fetch()` after a hostname check can be
rebound between validation and connection. Persisting arbitrary metadata adds
unbounded attacker-controlled content. Disabling metadata documents would break
the primary client-identification path in the approved spec.

## Decision 8: Dashboard consent and client setup are separate concerns

**Decision**: A dedicated `/oauth/operator-mcp/consent` page renders the
session-bound consent transaction. The API Access settings tab renders the
client chooser and authoritative grant inventory. A focused `operatorMcpSetup`
module, not authorization, owns versioned launch artifacts. Setup artifacts can start a
client-specific handoff, but connection state comes only from validated grants.

**Rationale**: OAuth may begin outside the dashboard, while discovery and grant
management must still be available inside it. Keeping the surfaces separate
prevents a UI choice from being treated as client identity or consent.

**Alternatives considered**: Embedding consent only in workspace settings would
break external OAuth redirects. Marking a setup click as connected would lie
about grant state.

## Decision 9: No new worker or AMQP contract in limited rollout

**Decision**: None of the three initially eligible descriptors enqueues new
work or changes an existing queue payload. The proposal only persists a pending
record. All current act descriptors remain excluded, so document worker
dispatch, AMQP payloads, retry behavior, and queue documentation are unchanged.

**Rationale**: This satisfies the required queue impact review while keeping
the act gate honest. Any future eligible act that queues work must revise its
disposition and prove owner-level queue semantics before GA.

**Alternatives considered**: Treating queue review as a later cleanup would
violate the constitution. Building a generic new operator queue is unnecessary
for synchronous MCP admission and would create a second execution authority.

## Decision 10: Observability is safe and low-cardinality

**Decision**: Emit counters/timers for OAuth stages, grant denials, MCP list and
tool outcomes, budget refusal, and dependency degradation. Audit grant lifecycle
and representative invocation outcomes with opaque IDs and fixed reason codes.
Trace standalone-to-backend admission with generated correlation IDs. Never put
client names, user/workspace IDs, scopes, descriptors, tokens, inputs, outputs,
prompts, or document content in metric labels or unrestricted logs/traces.

**Rationale**: The feature adds security-sensitive runtime and cross-process
failure paths that operators must diagnose, but customer content and credentials
must stay out of observability.

**Alternatives considered**: No observability would make revocation and proof
failures opaque. Full payload logging would violate FR-030 and the constitution.

## Decision 11: Cross-process DTOs have a narrow shared owner

**Decision**: Add `packages/operator-mcp-contract/` for transport-neutral
catalog/invocation DTOs and canonical internal proof signing/verification only.
Both the backend and standalone MCP package depend on it. Do not overload the
agent-channel `mcp-source-proof` package.

**Rationale**: The existing source proof signs peer-address provenance and lacks
grant, invocation, descriptor, resource, nonce, and replay claims. Importing
those concerns from the whole MCP server package would reverse ownership and
make backend domain behavior depend on transport runtime code.

**Alternatives considered**: Duplicated structural DTOs can drift; adding the
claims to `mcp-source-proof` destroys that package's narrow purpose; importing
the MCP runtime into backend authorization couples unrelated lifecycle.

## Decision 12: Tenure revocation extends the existing lifecycle seam

**Decision**: Store the account membership UUID on every operator grant and
extend the existing machine-access lifecycle transaction so membership,
workspace, account, or user removal also revokes matching operator grants.
Every protected request still verifies active membership by ID. Add a real
nullable `users.disabled_at` state and make session and operator authentication
deny it; no new user-administration UI is added.

**Rationale**: Re-invitation already creates a new membership UUID, and the
existing lifecycle transaction supplies atomic, multi-instance revocation.

**Alternatives considered**: A best-effort event listener could leave active
credentials after a lifecycle mutation. Creating a second tenure identifier
would duplicate account authority. An always-allow placeholder port would not
satisfy the approved immediate user-disablement requirement.

## Decision 13: Issued scopes and client snapshots are immutable ceilings

**Decision**: Persist the exact approved or narrowed tool scopes on every access
credential and refresh lineage/generation. Persist an immutable normalized
client metadata snapshot and bind its ID/digest from transaction through code,
grant, and credentials. Admission intersects issued scopes, current grant
scopes, current client version/status, and live account authority.

**Rationale**: A token exchange may narrow scopes; reading only the grant later
would silently re-expand authority. Refetching mutable CIMD during exchange
could change the redirect or client after consent.

**Alternatives considered**: Encoding scopes only in a token payload still
requires authoritative storage and complicates refresh. A mutable client row
loses the identity the user actually approved.

## Decision 14: Dynamic registration is evidence-gated and initially off

**Decision**: Frozen Codex CLI 0.149.0 and Claude Code 2.1.149 use CIMD or exact
preregistration; ChatGPT uses CIMD or predefined identity. No frozen supported
row currently requires DCR, so the server does not expose or advertise a DCR
endpoint. If compatibility evidence requires DCR, that client is not labeled
supported until bounded registration and abuse-control tests land.

**Rationale**: The spec permits DCR only as a compatibility path for a named
supported client. Anonymous registration without demonstrated need adds attack
surface.

**Alternatives considered**: Always-on DCR violates the compatibility-only
boundary. Claiming DCR while omitting implementation makes metadata dishonest.

## Decision 15: Operator Copilot owns direct invocation state

**Decision**: Authorization owns client/grant/credential persistence only.
Operator Copilot owns internal catalog/invoke routes, admission-proof
consumption, descriptor authorization, durable verification budgets,
reconciliation, and invocation receipts through its own narrow repository port.

**Rationale**: Tool meaning, cost, idempotency, proposal provenance, and safety
are Operator Copilot rules rather than OAuth lifecycle rules.

**Alternatives considered**: Putting invocation in authorization creates a fat
domain that knows tool details. Putting it in the standalone edge makes
transport the product authority.

## Decision 16: Operator tool catalog caching starts disabled

**Decision**: Build each tools/list response from current grant, client, tenure,
role, and disposition state and send no reusable catalog cache hint. Only public
OAuth/protected-resource discovery metadata may use bounded caching.

**Rationale**: A coherent permission and eligibility fingerprint could be
built later, but a TTL-only private cache can expose stale authority and has no
demonstrated initial performance need.

**Alternatives considered**: Cross-instance invalidation is unnecessary initial
complexity. Revalidation only at invocation fails the approved discovery rule.

## Decision 17: Externally monotonic credential epochs gate every replica

**Decision**: Require an operator-configured monotonic credential epoch outside
the database backup together with the internal credential key. Persist the
epoch and a non-reversible key fingerprint in PostgreSQL. Startup never invents
or auto-advances an epoch: it may initialize an empty row or advance only to a
higher configured epoch, and it fails readiness when the configured epoch is
lower than persisted state or the same epoch has a different fingerprint.
Grants, access rows, refresh rows, and proofs bind the configured epoch. Rotation
and restore procedures explicitly raise the external epoch; every enabled
replica must converge on the same epoch and fingerprint before becoming ready.

**Rationale**: Database-only generation loses its monotonicity when an old
database and old key are restored together, and automatic key-change updates
race during rolling deploys. An external generation survives the backup
boundary and makes overlapping mismatched replicas fail closed.

**Rationale**: Opaque token digests alone do not observe key rotation, and an
old database restore could otherwise revive older lineages.

**Alternatives considered**: Deleting token rows at deploy is operationally
brittle. Trusting access expiry leaves refresh lineages valid too long.
