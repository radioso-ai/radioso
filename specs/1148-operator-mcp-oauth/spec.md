# Feature Specification: Operator MCP With Delegated OAuth

**Feature Branch**: `review-ray-mcp-oauth`  
**Created**: 2026-09-03  
**Status**: Approved for engineering planning  
**Input**: User description: "Allow users to connect Claude Code, Codex, and other remote MCP clients to Ray's governed operator tooling through OAuth, then critique and strengthen the specification before implementation."

## Context

Ray's operator catalog now covers the core operating loop: notice a problem,
diagnose it, test a possible correction, perform bounded operational actions,
and draft reviewable changes. The catalog was designed to be reusable by a
future MCP operator surface, but today it is available only inside an
interactive dashboard session. The existing MCP surface serves a different
purpose: it binds one credential to one authored agent and exposes only that
agent's conversational tool.

Operators who prefer Claude Code, Codex, or another MCP host therefore cannot
use the governed Ray capabilities without returning to the dashboard. Giving
those hosts an ordinary personal token would recreate the broad pasted-token
workflow Ray was intended to replace, would not provide standard delegated
consent, and would blur the boundary between operator access and agent-channel
access.

This feature introduces a distinct operator MCP surface. A human signs in to
Radioso in a browser, chooses one workspace, reviews the requested capability
categories, and delegates no more authority than their current workspace role
allows. The external host receives Ray's governed tools directly; it does not
invoke a second Ray language-model loop. Existing Ray safety, capability
provenance, permission checks, budgets, proposal semantics, audit attribution,
and never-list boundaries remain authoritative.

## Decisions Already Made

- The user-facing product is "use Radioso's operator capabilities from your MCP
  client." OAuth is the access layer, not the product by itself.
- The operator MCP surface is distinct from the existing single-agent MCP
  conversation surface. Credentials and authority are never interchangeable.
- MCP clients consume eligible Ray tool descriptors directly. There is no
  `ask_ray` wrapper and no Radioso-funded nested model conversation.
- OAuth grants represent a human user acting in one workspace and can only
  narrow the user's live workspace permissions.
- Every production descriptor receives a reviewed MCP disposition. Eligible
  descriptors may span reads, probes, bounded acts, and proposal creation, but
  no shape or descriptor is eligible merely because it exists. The existing
  never-list remains excluded.
- Proposal creation is available, but proposal application and dismissal remain
  explicit interactive dashboard actions for this feature. A future remote
  application flow requires a separately approved, server-verifiable human
  confirmation design; generic host-side tool approval is not sufficient.
- The operator resource targets MCP `2026-07-28`, including its stateless request
  model and authorization requirements. It does not add the new protocol to the
  compatibility-protected single-agent resource. Supporting an older MCP
  transport revision is outside this feature.
- The public operator resource is served by the standalone MCP service at a
  distinct path. Radioso's application origin owns interactive authorization,
  consent, token lifecycle, and current-grant validation. Raw operator access
  credentials never become credentials for product-domain API calls.
- MCP-created proposals use a transport-neutral operator invocation as their
  provenance. They do not create synthetic Ray conversations, and the dashboard
  can review them through a proposal URL that does not depend on a Ray thread.

## OAuth Capability Categories

OAuth scopes are a deny-only ceiling over the user's live workspace authority.
They correspond exactly to Ray's reviewed tool shapes:

| OAuth scope | Eligible descriptor shape | User-facing meaning |
|-------------|---------------------------|---------------------|
| `operator:read` | `read` | Inspect workspace and agent state the user may already view |
| `operator:probe` | `probe` | Run bounded diagnostics or verification that may spend compute |
| `operator:act` | `act` | Perform an admitted safe operational effect |
| `operator:propose` | `propose` | Create a reviewable proposal without applying it |

The authorization request must ask for a non-empty subset of these four tool
scopes and may additionally request `offline_access`, a recognized lifecycle
scope that maps to no descriptor. Protected-resource metadata, tool challenges,
and catalog challenges advertise only tool scopes; authorization-server
metadata also advertises `offline_access`. The consent screen may approve any
subset of requested tool scopes and may independently deny `offline_access`
without denying tool access. An unknown scope makes the request fail as
`invalid_scope` rather than being ignored. The token exchange may omit `scope`
to retain the exact approved set or repeat an equal/narrower set, but may never
expand it.

Adding a scope requires a new interactive authorization. Reauthorization for the
same user, client, workspace, and resource supersedes the prior grant and revokes
its credential lineage only after the replacement grant succeeds. Removing a
scope takes effect immediately. `offline_access` is separate from tool authority:
refresh credentials are issued only when it was requested and explicitly
approved.

## MCP Protocol And Deployment Profile

The operator resource has one initial topology and protocol profile:

- The standalone MCP service exposes a canonical public resource such as
  `https://<mcp-origin>/operator/mcp`; the existing agent resource remains at its
  existing address and behavior.
- The MCP origin publishes RFC 9728 protected-resource metadata at the canonical
  path-specific well-known address and advertises Radioso's application origin
  as its authorization server. A `401` challenge carries the metadata URL and
  requested scopes.
- Radioso's application origin publishes authorization-server metadata and owns
  the browser authorization, consent, token, refresh, revocation, client
  identification, and validation endpoints.
- Every authorization and token request carries the exact operator resource as
  the RFC 8707 `resource`; issued credentials are accepted only for that
  audience. Access credentials travel only in the HTTP Bearer header, never in a
  URI or tool argument.
- The standalone resource may present the raw credential only to the
  authorization service's validation boundary. It must call product capability
  endpoints with a short-lived, service-authenticated internal principal proof
  that names the validated grant and invocation, never by passing through the
  user's OAuth credential. The backend revalidates grant version, tenure,
  workspace, categories, and live permissions rather than trusting the proof as
  independent authority.
- Backend capability entry points used by the standalone service are not public
  alternate operator APIs: they reject direct callers without the expected
  service identity and operator invocation proof.
- Operator requests use the MCP `2026-07-28` stateless, self-describing model,
  including method/name routing metadata and grant-private catalog cache hints.
  No operator MCP session or initialization handshake is introduced.
- Missing or invalid credentials receive protocol-conformant `401` responses;
  a valid credential lacking the required scope receives a conformant `403`
  insufficient-scope response. Both advertise only safe metadata and never leak
  workspace or tool-result details.
- A merged/backend-mounted operator MCP transport and compatibility with older
  MCP transport revisions are outside this feature. Supporting them later must
  reuse the same authorization and catalog contracts rather than create another
  authority model.

## Client And Redirect Profile

| Client profile | Redirect policy | Client authentication policy |
|----------------|-----------------|------------------------------|
| Web client | HTTPS URI matching registered scheme, host, port, and path exactly; no wildcard or fragment | Preregistered or validated HTTPS Client ID Metadata Document |
| Native loopback client | HTTP literal `127.0.0.1` or `[::1]`; exact address and path, with only the ephemeral port allowed to vary | Public client with S256 proof key; no client-secret reliance |
| Private URI-scheme client | Denied by default; allowed only for a specifically preregistered and compatibility-tested client with an exact reverse-domain-style URI | Public client with S256 proof key; no client-secret reliance |

`localhost` hostnames are not accepted as loopback identity. Client ID Metadata
Documents must use HTTPS with a non-root path, contain a `client_id` exactly
matching their URL, declare compatible response, grant, application, and token
authentication types, and contain the exact requested redirect. Fetches validate
DNS results and every redirect hop against public-network, scheme, timeout, size,
and redirect-count limits. Validated metadata is pinned for the authorization
transaction so a later fetch cannot change an in-flight redirect.

Dynamic client registration is a compatibility-only path for named supported
clients that cannot use metadata documents or preregistration. Registrations are
rate limited, bounded in lifetime and metadata size, classified as web or native,
grant no user or workspace access by themselves, and cannot rely on a secret for
public clients. Arbitrary anonymous DCR is not a general-availability promise.

## Launch Client Matrix

Compatibility is a release contract, not an assumption. At implementation
freeze, a version-controlled fixture records the exact stable build tested,
observed redirect URI, metadata documents, discovery transcript, and expected
failure behavior for every row. Each supported client surface and build has a
versioned setup artifact containing its display name, supported version, handoff
type, exact command or configuration template, permitted launch target,
canonical-resource insertion rule, expected validated client identity and
redirect mechanism, and safe failure and recovery guidance. Codex CLI, desktop,
and IDE are separate artifacts even when they share a matrix row. No client
surface may be presented as verified without a complete passing artifact. The
release gate reruns each fixture against the named build and the current hosted
client where applicable.

| Launch client | Required primary path | Bounded compatibility path |
|---------------|-----------------------|----------------------------|
| Codex CLI, desktop, and IDE extension | Remote HTTP plus OAuth discovery and Client ID Metadata Document | Dynamic registration only if the frozen named build cannot complete CIMD; the exception and redirect are pinned in its fixture |
| Claude Code | Remote HTTP plus automatic OAuth discovery and Client ID Metadata Document, using its native loopback callback | Preregistered public client with an exact loopback callback, or dynamic registration, only when the frozen named build requires it |
| ChatGPT custom app in developer mode | Remote MCP plus OAuth discovery and Client ID Metadata Document | Predefined client or dynamic registration only when required by the frozen hosted-client journey |

Support does not mean “latest” without evidence. A client is supported only
when its named fixture passes the complete launch journey. A client release that
changes discovery, client identification, redirect behavior, or the negotiated
MCP revision remains unsupported until its fixture is reviewed and updated.

## External-Client Trust Model

Any HTTPS client with a valid Client ID Metadata Document may request access;
Radioso does not certify that client's behavior. The consent screen clearly says
that the named external client may receive workspace data allowed by the
approved scopes and live role, displays the client and redirect host, and links
to the client's declared identity. Users are responsible for trusting a client
before approval. This matches the existing ability of a user to send data they
may access to a client using a personal credential, while OAuth makes the grant
visible, narrower, and revocable.

This feature does not add a workspace domain allowlist, data-class policy, or
enterprise DLP system. Deployment operators may disable operator MCP globally;
workspace owners and administrators may inspect and revoke grants. A later
workspace egress-policy feature may further deny authorization but must not
weaken live role checks.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect an MCP Client as Myself (Priority: P1)

As a workspace user, I can add Radioso's operator MCP endpoint to a supported
client, sign in to Radioso through my browser, select one workspace, review the
requested capability categories, and approve access without copying a secret
token into the client.

**Why this priority**: Human-delegated identity is the security and usability
foundation. No operator tool may be exposed until Radioso knows which user,
workspace, client, and consent grant the request represents.

**Independent Test**: Configure a supported MCP client with only the operator
MCP URL, complete browser authorization as a member of two workspaces, select
one workspace, and verify the client connects only to that workspace without a
manually created or pasted Radioso credential.

**Acceptance Scenarios**:

1. **Given** an unauthenticated supported MCP client, **When** it discovers the
   operator MCP resource, **Then** it can discover how to request authorization
   using the current MCP authorization flow.
2. **Given** a user who is not signed in to Radioso, **When** authorization
   begins, **Then** the user signs in through the ordinary Radioso login flow
   before any workspace or capability is granted.
3. **Given** a signed-in user with access to multiple workspaces, **When** the
   user authorizes the client, **Then** the user must select exactly one
   workspace and see the client identity and requested capability categories
   before approving.
4. **Given** a client requesting a capability category unavailable to the user,
   **When** consent is evaluated, **Then** unavailable authority is not granted
   or implied, and the consent view explains that workspace permissions remain
   controlling.
5. **Given** a user who cancels, denies, or abandons authorization, **When** the
   client continues, **Then** it receives no operator access and no reusable
   credential is created.
6. **Given** an invalid redirect, stale authorization attempt, mismatched
   browser state, incorrect issuer, or authorization code replay, **When** the
   flow is completed, **Then** access is denied without exposing account,
   workspace, or credential details.
7. **Given** a consent page opened from an existing browser session, **When** the
   user approves or denies, **Then** the decision is bound to the authorization
   transaction, current user, current account, anti-forgery proof, and an
   unframeable top-level page; a changed or stale session requires restarting or
   reauthenticating.
8. **Given** a client requesting unknown scopes, no scopes, or a mixture of known
   and unknown scopes, **When** authorization is evaluated, **Then** the request
   fails without silently choosing or dropping authority; a valid requested set
   may be partially approved by the user.

---

### User Story 2 - Add Radioso to My Preferred AI Client From the Dashboard (Priority: P1)

As a workspace user, I can open Radioso's operator MCP settings, choose my
preferred supported AI client, and follow a client-specific handoff to add
Radioso without searching documentation, constructing configuration by hand, or
copying a reusable Radioso secret.

**Why this priority**: OAuth is only a product feature if users can discover and
complete it from the product. Requiring users to translate protocol
documentation into client configuration would make the safest path feel harder
than personal credentials and materially reduce adoption.

**Independent Test**: Starting only from the Radioso dashboard, choose each
launch client surface in turn, use the presented handoff or configuration,
complete its browser authorization journey, and identify the fresh grant in the
authorized-client inventory by its independently validated client identity,
workspace, and capability categories rather than by the earlier UI selection.

**Acceptance Scenarios**:

1. **Given** operator MCP is available, **When** a user opens its connection
   screen, **Then** they see unambiguous choices for Codex CLI, Codex desktop,
   Codex IDE, Claude Code, ChatGPT, and another MCP-compatible client, with the
   verified version or hosted-client validation date for each named surface.
2. **Given** a user selects a launch client surface, **When** its complete,
   passing setup artifact exists for the displayed version, **Then** Radioso
   offers that artifact's handoff and previews the permitted destination and
   expected authorization flow before opening another application or site.
3. **Given** a safe one-click handoff is unavailable or unverified for the
   selected client build, **When** setup is shown, **Then** Radioso provides the
   shortest exact client-specific command or configuration containing the
   canonical operator MCP URL but no access credential, refresh credential,
   client secret, or workspace data.
4. **Given** a user chooses another MCP-compatible client, **When** no named
   compatibility fixture exists, **Then** Radioso supplies the canonical MCP URL
   and standards-based manual steps, labels the client as unverified, and does
   not imply supported behavior or silently choose a weaker authorization path.
5. **Given** setup reaches browser authorization, **When** the user reviews the
   request, **Then** the normal consent flow still identifies the actual client,
   workspace, scopes, redirect host, and external-data warning rather than
   trusting the dashboard selection as authorization.
6. **Given** any client completes authorization, **When** the user returns to or
   refreshes the Radioso connection screen, **Then** it shows fresh grants from
   the authorized-client inventory using only validated OAuth client identity
   and grant metadata and offers inspect and revoke actions. It does not mark a
   dashboard selection as connected or associate it with a grant unless the
   authorization transaction supplies a server-verifiable correlation that
   preserves the canonical resource and actual client identity.
7. **Given** operator MCP is disabled, misconfigured, or unavailable, **When**
   the connection screen opens, **Then** setup actions are disabled and the user
   sees an actionable availability state without being directed to create a
   personal credential as a workaround.
8. **Given** a self-hosted deployment, **When** client-specific setup is
   generated, **Then** every handoff, command, and configuration uses the
   deployment's validated canonical public operator MCP resource rather than a
   Radioso-hosted default.

---

### User Story 3 - Use Only My Current Operator Capabilities (Priority: P1)

As an authorized user, I see and can invoke only the Ray tools allowed by both
my approved capability categories and my current workspace permissions. A role
change, access removal, or revoked consent changes access immediately rather
than leaving the client with stale authority.

**Why this priority**: An external model can call tools at machine speed. The
operator MCP surface must never become a more privileged or slower-to-revoke
path than the dashboard.

**Independent Test**: Connect two users with different roles to the same
workspace, compare their discovered tools and invocation results, then demote
and remove one user and verify protected reads and effects are denied on the
next request.

**Acceptance Scenarios**:

1. **Given** a valid operator grant, **When** the client lists tools, **Then** it
   sees only descriptors that are eligible for MCP, within the granted
   capability categories, and allowed by the user's current permissions.
2. **Given** a tool that requires several permissions, **When** the user lacks
   any one of them, **Then** the tool is not discoverable and cannot be invoked
   by guessing its name.
3. **Given** a user whose role or workspace access changes after tool discovery,
   **When** a later invocation resolves an entity, performs a protected read,
   runs a probe, records an act, or creates a proposal, **Then** current
   permissions are rechecked before protected data or an effect is produced.
4. **Given** a user removed from the workspace and later reinvited, **When** an
   old access or refresh credential is presented, **Then** the old continuous
   access tenure does not revive and the user must authorize again.
5. **Given** an operator token presented to the single-agent MCP surface, or an
   agent, personal, service-account, public-chat, embed, or other token presented
   to the operator surface, **When** authentication runs, **Then** it is rejected
   before tool discovery or invocation.
6. **Given** a token issued for a different resource, deployment, workspace, or
   client grant, **When** it is presented, **Then** it grants no access.
7. **Given** two standalone MCP instances and a grant revoked through the
   dashboard, **When** the next request is routed to the other instance, **Then**
   it observes the revocation from authoritative state and denies access.
8. **Given** a valid grant whose capability categories are reduced during entity
   resolution or result enrichment, **When** the next authorization checkpoint
   runs, **Then** protected output is suppressed and no later stage proceeds.

---

### User Story 4 - Diagnose and Propose From an External Agent (Priority: P2)

As an authorized operator, I can use an external agent to inspect workspace
state, diagnose agent behavior, run bounded verification, perform safe
operational acts, and create reviewable proposals using the same governed
capabilities available to Ray in the dashboard.

**Why this priority**: This is the product value unlocked by OAuth. Connecting
successfully but exposing a token-only or partial diagnostic surface would not
complete the operator's core workflow.

**Independent Test**: From a supported MCP host, diagnose a seeded failing agent
turn, test a proposed correction, create a proposal, and verify that every
result is structured, attributed, bounded, and linked to the relevant Radioso
dashboard object without running a second Radioso model conversation.

**Acceptance Scenarios**:

1. **Given** an eligible Ray descriptor that does not depend on dashboard-only
   page context, **When** it is available to the user, **Then** it appears as one
   MCP tool with the same meaning, input validation, output bounds, permission
   requirements, cost declaration, and capability provenance as the dashboard
   catalog.
2. **Given** a descriptor that depends on ambient dashboard state and has no
   explicit MCP-safe input or resolution behavior, **When** the MCP catalog is
   assembled, **Then** it is excluded with a reviewed reason rather than exposed
   in a form that guesses context.
3. **Given** a tool result referring to a workspace entity or proposal, **When**
   the client receives it, **Then** the result contains a bounded structured
   representation and a useful dashboard handoff link where one exists.
4. **Given** a probe or act with declared cost, **When** it is invoked repeatedly,
   **Then** existing user/workspace budgets and abuse controls apply to the MCP
   surface and refusals explain safe retry or handoff behavior.
5. **Given** a proposal-producing tool, **When** it succeeds, **Then** it creates
   a pending review artifact with the same payload, evidence, and guards as the
   dashboard catalog, records the MCP invocation rather than a synthetic Ray
   conversation as its origin, and performs no target-domain mutation.
6. **Given** a pending proposal returned through MCP, **When** the external model
   asks to apply or dismiss it, **Then** no MCP tool performs that decision and
   the result directs the human to an authenticated dashboard proposal review
   URL that does not depend on an originating Ray thread.
7. **Given** a never-listed action involving identity, membership, credentials,
   secrets, destructive administration, or an unattended customer reply,
   **When** an external model asks for it, **Then** no executable tool is exposed
   and any relevant refusal or handoff preserves Ray's reviewed boundary.
8. **Given** an operator MCP tool call, **When** it executes, **Then** Radioso
   invokes no additional language model solely to interpret or route that call.
9. **Given** an MCP client that retries after losing an act or proposal response,
   **When** the same stable operation identity is presented again, **Then** the
   caller receives the original or reconciled outcome and no duplicate effect,
   queued job, model spend, eval verdict, or proposal is created.
10. **Given** an act without an owning-module idempotency or reconciliation
    guarantee, **When** descriptor MCP eligibility is reviewed, **Then** it is
    excluded even if another act descriptor is safe to expose.

---

### User Story 5 - Review and Revoke Connected Clients (Priority: P2)

As a workspace user, I can see the external clients I have authorized, understand
their workspace and capability reach, and revoke access without finding or
rotating a copied secret.

**Why this priority**: Delegated access is trustworthy only when it is visible,
attributable, and easy for the resource owner to end.

**Independent Test**: Authorize two clients, review their safe connection
metadata in the dashboard, revoke one, and verify its access and refresh
credentials fail on the next use while the other connection continues.

**Acceptance Scenarios**:

1. **Given** one or more authorized clients, **When** the user opens operator MCP
   access settings, **Then** the user sees safe client identity, workspace,
   capability categories, creation time, recent-use time, and status without any
   token or reusable secret.
2. **Given** a user viewing their own grant, **When** they revoke it with explicit
   confirmation, **Then** all access and refresh credentials in that grant's
   lineage fail on their next use.
3. **Given** an owner or administrator reviewing workspace access, **When** they
   inspect or revoke another user's grant, **Then** they can see only safe metadata
   and revoke it without impersonating the user or learning a credential.
4. **Given** a consumed refresh credential, including one retried after a lost
   response or presented concurrently, **When** it is presented again, **Then**
   the whole lineage is revoked, any issued successor becomes unusable, and the
   event is attributable without recording the credential. Revoked or expired
   credentials fail without reviving or extending their lineage.
5. **Given** a workspace owner or administrator, **When** they review operator
   MCP grants in their workspace, **Then** they can revoke any grant in that
   workspace but cannot approve, expand, refresh, or use it for the grant owner.

---

### User Story 6 - Operate Reliably Across Supported MCP Hosts (Priority: P3)

As an operator or self-hosting administrator, I can enable the operator MCP
surface, connect supported local and cloud MCP hosts, understand its security
requirements, and troubleshoot availability without weakening the ordinary API
or single-agent MCP boundaries.

**Why this priority**: A standards-compliant implementation still fails as a
product if common hosts cannot complete authorization or self-hosters cannot
deploy the public endpoints safely.

**Independent Test**: Enable the feature in a production-like deployment and
complete authorization, discovery, one read, one probe, one proposal, refresh,
and revocation from the exact launch-matrix builds of Codex, Claude Code, and
ChatGPT custom apps. General availability additionally requires one bounded act
to pass the stateful-operation release gate from every launch client.

**Acceptance Scenarios**:

1. **Given** a deployment where operator MCP is disabled or misconfigured,
   **When** a client or dashboard user checks availability, **Then** the surface
   fails closed and presents a safe, actionable status without affecting the
   ordinary API or single-agent MCP service.
2. **Given** a supported client using current MCP client identification, a
   preregistered identity, or an approved legacy compatibility mechanism,
   **When** authorization starts, **Then** redirect identity is validated against
   the selected mechanism and no weaker fallback is silently chosen.
3. **Given** a deployment behind a trusted proxy, **When** authorization and MCP
   requests arrive, **Then** canonical public origins, redirect addresses,
   resource identifiers, source controls, and secure transport remain
   consistent with deployment configuration.
4. **Given** the existing single-agent MCP smoke suite, **When** operator MCP is
   enabled or disabled, **Then** agent credential exchange and `ask_agent`
   behavior remain unchanged.
5. **Given** a supported host, **When** it uses MCP `2026-07-28`, **Then** each
   operator request is self-describing and stateless, and a cached catalog is
   never shared across grants, users, or workspaces.

### Edge Cases

- A user signs in successfully but has no active workspace access.
- A workspace is deleted, suspended, or becomes unavailable during consent,
  refresh, tool listing, or a long-running invocation.
- The selected workspace changes ownership or the user changes role while an
  authorization code or refresh operation is in flight.
- Two browser tabs attempt to approve, deny, or reuse the same authorization
  request.
- A client changes its redirect metadata after registration or serves malformed,
  oversized, private-network, redirecting, or unavailable client metadata.
- A malicious client attempts open redirects, authorization-server mix-up,
  resource confusion, scope escalation, code interception, refresh replay, or
  cross-workspace token substitution.
- A malicious page frames the consent screen, submits a consent decision with a
  different browser session, or obtains sensitive authorization details through
  referrer headers or browser history.
- A client requests no recognized capability category, unsupported categories,
  or a mix of supported and unsupported categories.
- A previously visible tool is removed or changes schema while a client caches
  the catalog.
- A client repeats a stateful tool call after a timeout, sends the same operation
  concurrently to two instances, or changes the payload while reusing an
  operation identity.
- A tool is authorized when listed but unauthorized when invoked because a role,
  grant, target entity, or workspace changed.
- A long-running probe crosses access-token expiry, user demotion, grant
  revocation, cancellation, or budget exhaustion.
- An eligible descriptor returns more data than the MCP result limit or refers
  to an entity the caller may no longer read during enrichment.
- The authorization service, persistence layer, audit sink, rate limiter, or
  optional shared runtime store is unavailable.
- A deployment is restored from backup with old authorization codes, refresh
  lineages, grants, or signing material.
- Multiple Radioso deployments share a hostname or identity provider but must
  remain separate OAuth resources and token audiences.
- A valid authorization was admitted immediately before role reduction or grant
  revocation and is still running when the change commits.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend development MUST follow TDD: each behavior and security boundary is
  written and observed failing before implementation.
- Backend services MUST remain in Node.js; any dashboard work MUST remain in
  React and reuse the shared dark theme and existing design tokens.
- PostgreSQL remains the system of record for grants, consent, client identity,
  token lineage, and audit-linked lifecycle state requiring persistence.
- The feature introduces no new runtime LLM prompt or provider call. If later
  discovery adds one, the spec must be revised and runtime prompt assets must
  live under `backend/prompts/`; user-facing conversational copy must come from
  the LLM rather than hard-coded English behavior.
- Secrets, signing keys, and credentials MUST use environment-backed secret
  configuration, MUST NOT be committed, and MUST be reflected safely in
  `.env.example` when configuration changes.
- Customer data MUST be protected through least privilege, secure transport,
  current-permission checks, bounded outputs, safe failure, and attributable
  audit records.
- Public contract changes MUST originate in the code-first contract and
  regenerate backend OpenAPI artifacts and the TypeScript SDK snapshot.
- MCP contract changes MUST update package contracts, compatibility coverage,
  setup documentation, and deployment documentation in the same change.
- The plan MUST review document-worker dispatch, AMQP payloads, retries, queue
  semantics, and queue documentation for every admitted descriptor. No new
  queue contract is expected, but an eligible act that dispatches existing work
  must prove that its payload, retry, duplicate, cancellation, and reconciliation
  semantics remain valid through operator MCP.
- Application composition MUST assemble transport, authorization, catalog, and
  persistence implementations; it MUST NOT own role, OAuth, tool eligibility,
  proposal, or domain mutation policy.
- Backend runtime paths added for discovery, authorization, token lifecycle,
  tool execution, denial, degradation, and revocation MUST include appropriate
  low-cardinality logs, metrics, audit events, and traces without recording
  sensitive content.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The operator MCP transport owns MCP protocol negotiation,
  resource discovery, tool presentation, and transport-level errors. A focused
  inbound authorization domain owns client identity, human consent, grant and
  token lifecycle, audience binding, and revocation. Account access remains the
  sole authority for workspace membership, role, and permissions. Operator
  Copilot remains the owner of tool descriptors, capability provenance, tool
  eligibility, bounded projections, budgets, proposals, and never-list policy.
  Owning application modules remain authoritative for every protected read,
  probe, act, and target-domain mutation. Persistence adapters store state but
  decide no authorization policy. Application composition only wires these
  boundaries. In the initial topology, the standalone MCP service is the public
  protected resource, while the Radioso application origin is the authorization
  service and owns backend capability invocation. The standalone service never
  becomes a domain authority or product-data store.
- **Encapsulation Rule**: The existing single-agent MCP server must remain a
  role-free, one-agent conversation surface and must not learn operator catalog
  policy. Operator Copilot must not learn OAuth protocol or token-persistence
  mechanics. The outbound `integrationOauth` module must remain an OAuth client
  for Radioso-to-provider connections and must not become the inbound
  authorization server. Account access must not learn MCP tool definitions.
  Route handlers, protocol adapters, and repositories must not absorb grant,
  role, scope, proposal, or domain rules.
- **New Seams Required**:
  - an inbound authorization contract that resolves a validated operator grant
    to one current human principal and one workspace without granting domain
    permissions itself;
  - a current-access evaluator that receives grant identity and version plus the
    descriptor's fixed shape/category, and intersects them with live membership,
    continuous access tenure, role, and descriptor permissions at every
    protected checkpoint without teaching account access about tools;
  - a mandatory per-descriptor MCP disposition: either eligible with explicit
    transport-safe input, context-free resolution, retry/effect behavior, and
    invocation adapter, or excluded with a reviewed reason; a reverse-coverage
    ratchet must account for every production descriptor;
  - an operator MCP catalog adapter that maps eligible descriptors generically,
    preserves schemas and metadata, and refuses dashboard-context-only tools;
  - a distinct operator MCP runtime boundary so operator and agent credentials,
    caches, rate limits, audit surfaces, and resource identities cannot collide;
  - lifecycle persistence ports for grants, authorization transactions, client
    identities where retained, and refresh-token lineages;
  - a transport-neutral operator invocation and proposal-origin seam so an MCP
    call can own audit, evidence, idempotency, retention, and proposal provenance
    without manufacturing a Ray conversation;
  - a durable, atomic cost-reservation boundary keyed by workspace, user, grant,
    invocation identity, and descriptor cost, independent of a Ray turn and
    shared across instances;
  - an owning-module idempotency or reconciliation contract for every admitted
    act and proposal tool, including lost-response and concurrent-retry behavior;
  - a service-authenticated internal principal-proof and capability-invocation
    boundary between the standalone protected resource and backend, with
    authoritative backend revalidation rather than bearer-token passthrough;
  - a safe operator-client inventory and revocation boundary for the dashboard;
  - compatibility fixtures that prove client discovery and authorization without
    embedding client-specific product rules in domain services.
- **Dependency Direction**: MCP transport and dashboard transport depend on
  inbound-authorization and Operator Copilot public contracts. Operator Copilot
  depends on narrow owning-module application ports. Inbound authorization
  depends on account-access and lifecycle persistence ports. Composition depends
  on all contracts and concrete adapters to assemble them. Account access,
  owning domains, persistence, and the existing agent MCP surface never depend
  on the operator MCP transport.
- **Anti-Goals**:
  - Do not add `ask_ray`, a second language-model loop, or a second Ray tool
    catalog.
  - Do not accept ordinary API, personal, service-account, agent-channel,
    public-chat, or embed credentials at the operator MCP boundary.
  - Do not create a parallel role system or allow consent categories to grant
    authority absent from current workspace permissions.
  - Do not copy descriptor schemas or write one bespoke transport wrapper per
    tool when a generic governed adapter can preserve the contract.
  - Do not infer MCP eligibility merely because a descriptor or internal service
    exists; dashboard-context requirements and transport safety must be explicit.
  - Do not expose proposal application or dismissal until a separate feature
    defines server-verifiable, per-decision human confirmation.
  - Do not create empty, hidden, or synthetic Ray conversations to satisfy
    proposal foreign keys, evidence lookup, audit attribution, or budgets; make
    proposal and invocation provenance transport-neutral instead.
  - Do not expose identity, membership, credential, secret, destructive
    administration, or unattended customer-reply operations.
  - Do not pass an operator access token through to backend APIs or external
    providers as a substitute for a separately authorized internal call.
  - Do not cache a positive grant, tenure, category, or permission decision in a
    way that can authorize the next request after authoritative revocation.
  - Do not merge inbound authorization-server behavior into outbound integration
    OAuth merely to reuse protocol vocabulary.
  - Do not store raw tool inputs, results, prompts, completions, document content,
    retrieved chunks, authorization codes, access tokens, refresh tokens,
    cookies, client secrets, or connection strings in logs, metrics, traces,
    analytics, or unrestricted audit metadata.

### Ownership Questions

- **What does each area know?** Operator MCP knows protocol and how to present a
  governed descriptor, but not business rules. Inbound authorization knows the
  consenting human, client, workspace, categories, resource, and credential
  lineage, but not what an individual tool means. Operator Copilot knows tool
  meaning and safety but not token formats. Account access knows current
  authority but not MCP or OAuth. Owning modules know domain rules but not the
  calling transport.
- **What ports are exposed, and to whom?** Inbound authorization exposes grant
  issuance, validation, refresh, and revocation to HTTP/MCP transport; account
  access exposes current workspace authority to authorization evaluation;
  Operator Copilot exposes an eligible governed catalog and invocation boundary
  to the dashboard and operator MCP; owning modules expose narrow application
  ports to Operator Copilot; persistence exposes lifecycle repositories only to
  its owning domain services.
- **What is the dependency direction?** Broad transport and composition layers
  depend inward on narrower authorization, catalog, account-access, and domain
  contracts. Domain and persistence layers never reach outward into MCP,
  dashboard, or composition.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a distinct operator MCP resource for
  authenticated human workspace users without changing the authority or tool
  set of the existing single-agent MCP resource.
- **FR-002**: The operator MCP resource MUST expose eligible Operator Copilot
  descriptors directly and MUST NOT wrap them in an `ask_ray` or other nested
  conversational tool.
- **FR-003**: An unauthenticated supported client MUST be able to discover the
  protected resource, its authorization service, supported capability
  categories, and compatible client-identification mechanisms through MCP
  `2026-07-28`, RFC 9728 protected-resource metadata, and authorization-server
  metadata. Supporting an older MCP transport revision is not required.
- **FR-004**: Authorization MUST require an interactive human browser session,
  authorization code flow, S256 proof key, exact redirect validation, state and
  RFC 9207 issuer validation, and explicit consent. Consent submission MUST be
  bound to the current browser session and authorization transaction and
  protected against cross-site submission, framing, referrer leakage, and
  session/account replacement. Implicit, password, client-credential, and
  bearer-copy flows MUST NOT grant operator MCP access.
- **FR-005**: Consent MUST identify the requesting client, bind exactly one
  workspace, display requested capability categories, and allow the user to
  approve or deny before a reusable grant exists.
- **FR-006**: A grant MUST bind one client, one human user, one continuous
  workspace-access tenure, one workspace, one operator MCP resource, approved
  capability categories, creation and lifecycle state, and safe audit identity.
- **FR-007**: Capability categories MUST form a fixed, understandable,
  deny-only ceiling using exactly `operator:read`, `operator:probe`,
  `operator:act`, and `operator:propose`, mapped one-to-one to the catalog's
  read, probe, act, and propose shapes. They MUST NOT create permissions or
  replace workspace roles, and this feature MUST NOT introduce per-tool custom
  scopes.
- **FR-008**: The effective authority for discovery and every invocation MUST be
  the intersection of the grant's approved categories, the user's live
  continuous access tenure and current workspace permissions, the descriptor's
  fixed shape/category and required permissions, its current MCP disposition,
  and all existing deny-only Ray safety policy. The evaluator MUST receive the
  grant identity and current grant version; an outer catalog filter alone is not
  sufficient authority.
- **FR-009**: Current authority MUST be rechecked before every stage that can
  reveal protected information or cause an effect, including tool listing,
  entity resolution, dynamic labels, preflight reads, source reads, probes,
  acts, proposal creation, evidence creation, and result enrichment.
- **FR-010**: Data derived under permissions that are stale by the time of an
  authorization checkpoint MUST NOT be emitted to the client, persisted into a
  proposal, or written to observability surfaces.
- **FR-011**: Membership removal, tenure end, workspace loss, user disablement,
  grant revocation, client revocation, or deployment disablement MUST invalidate
  access on the next request. Role demotion or capability-grant reduction MUST
  reduce effective authority on the next request without requiring a new token.
  Every protected request MUST validate authoritative grant version, tenure, and
  role state through a strongly coherent read or atomic revocation epoch; no
  positive authorization cache may outlive that check across instances.
- **FR-012**: Reinviting a removed user MUST create a new access tenure and MUST
  NOT revive any prior operator MCP grant or credential lineage.
- **FR-013**: Access credentials MUST be short lived, accepted only for the
  exact operator MCP resource and issuing deployment, and unusable as Radioso
  API, dashboard, agent MCP, public-chat, embed, integration, or downstream
  provider credentials. The default and maximum access lifetime MUST be 15
  minutes; deployments may configure a shorter lifetime but not a longer one.
- **FR-014**: Refresh credentials, when issued, MUST rotate on successful use,
  require explicit `offline_access` consent, expire after 30 days without use
  and after 90 days absolutely, be revocable as a lineage, and fail safely under
  replay, concurrency, expiry, tenure end, role loss, client revocation, and
  signing-key change. Each lineage has exactly one current generation. The
  first valid presentation atomically consumes that generation and issues its
  successor. Any later presentation of the consumed credential, including a
  concurrent duplicate or lost-response retry, is treated as replay and
  atomically revokes the entire lineage so any returned successor is unusable;
  the client must reauthorize. Clients must serialize refresh. Deployments may
  configure shorter but not longer lifetimes.
- **FR-015**: Authorization codes MUST be one-time, short lived, bound to the
  requesting client, exact redirect, proof-key challenge, operator resource,
  user, workspace, and approved categories, expire within five minutes, and MUST
  disclose no reusable credential through browser URLs or error messages.
- **FR-016**: The authorization service MUST support current URL-based client
  metadata and preregistered clients under the Client And Redirect Profile, plus
  a bounded dynamic-registration compatibility path only for named supported
  clients that still require it. Every method MUST validate client identity,
  client type, compatible grant/response/token-authentication types, and exact
  redirects; compatibility MUST NOT silently weaken current protections.
- **FR-017**: Fetching remote client metadata MUST enforce response-size,
  redirect-count, scheme, resolved-address, DNS-rebinding, timeout, caching, and
  self-identity validation protections that prevent server-side request forgery
  or mutable metadata from changing an authorization already in progress.
- **FR-018**: Tool discovery MUST include only descriptors with explicit MCP
  disposition. Eligibility MUST require a transport-safe schema, explicit-input
  or context-free safe resolution behavior, preserved capability provenance,
  permissions, tool shape, output bounds, cost, invocation adapter, retry and
  effect semantics, and never-list disposition. Every production descriptor
  MUST be accounted for as eligible or excluded with a reviewed reason before
  any operator catalog is exposed.
- **FR-019**: Tool invocation by guessed or cached name MUST resolve against the
  same current eligible catalog used for discovery and MUST fail closed when the
  descriptor is no longer present, authorized, or schema-compatible.
- **FR-020**: Eligible descriptors MUST be adapted generically from the
  production Operator Copilot catalog so dashboard and MCP cannot drift into
  separately authored meanings, schemas, permissions, shapes, budgets, or
  safety policy.
- **FR-021**: Every successful MCP tool result MUST be bounded and structured;
  when it references a readable Radioso entity, evidence record, or proposal,
  it MUST include a safe stable identity and a dashboard handoff link where a
  useful destination exists.
- **FR-022**: Operator MCP MUST reserve descriptor verification cost atomically
  in durable shared state before execution, keyed by workspace, user, grant, and
  stable invocation identity. The default ceiling is six verification-cost
  units per grant in a rolling 60-second window, in addition to existing
  workspace/provider limits; deployments may configure a stricter ceiling.
  Parallel requests MUST NOT oversubscribe it. A reservation is refunded only
  when execution is refused before external cost, queue dispatch, or persistence
  begins; disconnect or cancellation after work begins does not restore it.
  Reads remain subject to ordinary request-rate controls even when their
  verification cost is zero.
- **FR-023**: Existing bounded acts MAY be exposed only when they remain
  idempotent or safely retryable, reversible where promised, non-destructive,
  non-secret, non-identity-changing, and non-customer-replying. The MCP contract
  MUST declare a stable operation identity, effect boundary, retry and
  reconciliation behavior, maximum execution/cancellation semantics, and
  confirmation hints without treating client hints as authorization. Retrying a
  stable operation identity MUST return the original or reconciled result and
  MUST NOT repeat model spend, queue dispatch, persisted acts, eval verdicts, or
  proposals. Payload reuse with a different operation identity or payload
  mismatch on the same identity MUST fail safely. General availability is
  blocked until at least one named act has an owner-approved MCP disposition and
  passes lost-response, retry, concurrency, and multi-instance reconciliation
  tests; a limited read, probe, and propose rollout may precede that gate.
- **FR-024**: Proposal tools MUST create the same pending proposal, current-state
  snapshot, evidence, optimistic guard, and target-domain behavior as the
  dashboard catalog and MUST NOT apply or dismiss the proposal. Proposal and
  evidence provenance MUST support either a Ray conversation turn or a
  transport-neutral operator MCP invocation. MCP origin MUST retain user,
  workspace, client, grant, descriptor, idempotency, and audit linkage without a
  synthetic conversation, and MUST have an authenticated conversation-independent
  dashboard review URL.
- **FR-025**: Proposal application and dismissal MUST remain session-authenticated
  dashboard decisions in this feature. They MUST NOT be exposed through operator
  MCP, ordinary API credentials, OAuth refresh, or generic host approval.
- **FR-026**: The existing Ray never-list and permanent exclusions MUST remain
  enforced. OAuth authorization, client/grant management, identity, membership,
  credentials, secrets, destructive workspace or agent administration, provider
  authorization callbacks, and unattended customer replies MUST NOT become MCP
  tools.
- **FR-027**: Operator MCP calls MUST execute without creating a Ray conversation
  or invoking a Radioso language model solely for routing, interpretation, or
  answer composition. They MUST create only the minimum transport-neutral
  invocation receipt needed for authorization, idempotency, cost, audit,
  evidence, proposal provenance, and retention. Existing domain-owned model
  calls explicitly represented by a probe or act remain governed by that
  descriptor's budget and policy.
- **FR-028**: Every authorization lifecycle action and MCP invocation MUST be
  attributable to the human principal, workspace, client, grant, calling
  surface, tool when applicable, capability shape, outcome, and safe reason,
  while preserving existing domain audit semantics.
- **FR-029**: The feature MUST emit low-cardinality operational signals for
  discovery, authorization, token exchange and refresh, revocation, current-role
  denial, audience mismatch, catalog listing, tool outcome, budget refusal, and
  dependency degradation. Identifiers, names, tokens, inputs, results, prompts,
  completions, and customer content MUST NOT become metric labels.
- **FR-030**: No Radioso-owned response, browser URL, dashboard storage, log,
  trace, metric, analytics event, audit record, support view, MCP cache, or
  unrestricted error detail MUST expose or retain raw authorization codes,
  access credentials, refresh credentials, proof-key verifiers, session cookies,
  client secrets, tool inputs/results containing customer data, prompts,
  completions, documents, or retrieved chunks.
- **FR-031**: The dashboard MUST provide an operator MCP connection entry point,
  safe availability status, authorized-client inventory, grant detail, recent
  use, capability categories, and explicit revocation flow using existing UI
  patterns.
- **FR-032**: Users MUST be able to revoke their own grants. Workspace owners and
  administrators MUST be able to view safe metadata and revoke any operator MCP
  grant in their workspace, but MUST never be able to recover credentials,
  impersonate a user, approve consent for them, refresh their lineage, or expand
  their grant.
- **FR-033**: Operator MCP MUST be separately enableable and fail closed when
  required public-origin, signing, persistence, authorization, or transport
  dependencies are unavailable. Its failure MUST NOT make the dashboard,
  ordinary API, worker, or existing agent MCP surface unavailable. In the
  initial topology only the standalone MCP service exposes the public operator
  resource; the application origin owns authorization and backend capability
  execution, and a direct backend caller cannot bypass the standalone resource's
  service identity and invocation proof.
- **FR-034**: Existing agent MCP credentials, conversations, resource identity,
  session exchange, rate controls, audit behavior, and sole `ask_agent` tool MUST
  remain backward compatible whether operator MCP is enabled or disabled.
- **FR-035**: The feature MUST pass end-to-end compatibility journeys for the
  exact builds in the Launch Client Matrix: Codex CLI/desktop/IDE, Claude Code,
  and ChatGPT custom apps in developer mode. Coverage includes discovery,
  consent, tool listing, read, probe, proposal, refresh, role reduction,
  revocation, and reconnect using MCP `2026-07-28`; the general-availability
  gate additionally includes one owner-approved bounded act. A host that
  supports only an older transport revision is not supported for this feature.
- **FR-036**: Public authorization, lifecycle, and dashboard contracts MUST be
  represented in the code-first API contract where applicable, with regenerated
  backend artifacts and TypeScript SDK snapshot. MCP tool and authorization
  contracts MUST be versioned and tested from their owning package contract.
- **FR-037**: Operator, deployment, API, security, and client-setup documentation
  MUST distinguish inbound operator OAuth, outbound integration OAuth, ordinary
  API credentials, and single-agent MCP credentials, and MUST document enable,
  connect, consent, scope, expiry, refresh, revoke, failure, and recovery flows.
- **FR-038**: The plan MUST review every eligible descriptor that can enqueue
  existing work. Each such descriptor MUST prove unchanged worker and AMQP
  payload contracts, dispatch idempotency, retry and duplicate behavior,
  cancellation boundaries, and reconciliation through a lost response. If a
  new queue handoff or contract change is required, this specification and the
  affected queue documentation and tests MUST be revised before implementation.
- **FR-039**: Rollout MUST support compatibility and security validation with
  designated workspaces before broad availability, without changing the
  authorization semantics between limited and general availability. The
  limited rollout MAY expose only admitted reads, probes, and proposals;
  general availability MUST remain disabled until the bounded-act gate in
  FR-023 passes for every launch client.
- **FR-040**: The protected resource metadata MUST name the canonical operator
  resource and at least one authorization server. Missing or invalid credentials
  MUST receive `401` with a Bearer challenge containing the protected-resource
  metadata URL. Protected-resource metadata advertises only the four tool
  scopes; a challenge for a specific tool names that tool shape's required
  scope, while a general catalog challenge MUST NOT claim every scope is
  required. A valid
  credential that lacks a tool's shape scope MUST receive `403` with an
  `insufficient_scope` challenge before tool execution.
- **FR-041**: Authorization-server metadata MUST advertise authorization and
  token endpoints, S256 proof-key support, the four operator tool scopes plus
  the non-tool `offline_access` lifecycle scope, issuer, response and grant
  types, and supported client-identification mechanisms. `offline_access` MUST
  map to no descriptor and MUST NOT appear in a protected-resource or tool
  challenge. The authorization response MUST include an issuer value that the
  client can bind to the code exchange.
- **FR-042**: The exact canonical operator resource MUST be required as the
  `resource` in both authorization and token requests. A missing, ambiguous,
  broader, differently normalized, or unrecognized resource MUST fail; token
  validation MUST prove that exact audience before any MCP method is processed.
- **FR-043**: The authorization request MUST contain a non-empty subset of the
  four operator tool scopes and MAY also request `offline_access`. Unknown or
  mixed known/unknown scope requests fail as `invalid_scope`. Consent MAY
  approve a strict subset of tool scopes and independently deny
  `offline_access`; denial of refresh authority MUST NOT deny approved tool
  access. Token exchange may retain or narrow the approved set but never add to
  it. Scope expansion requires a new interactive consent and successful
  replacement grant.
- **FR-044**: Operator MCP requests MUST be stateless and self-describing under
  MCP `2026-07-28`; routing and authorization MUST validate the declared MCP
  method and tool name before parsing unrestricted request bodies. Tool-list
  results MAY be cached only with private grant-specific scope and a bounded
  lifetime; they MUST NOT be shared across grants, users, workspaces, or
  deployments.
- **FR-045**: Client ID Metadata Documents MUST follow the Client And Redirect
  Profile, including HTTPS URL identity with a path, exact `client_id` self-match,
  compatible metadata, and exact redirect membership. Consent MUST display the
  declared client name, identity origin, and redirect host and warn clearly for
  loopback or specially preregistered private-scheme redirects.
- **FR-046**: Dynamic registration MUST be compatibility-only, rate limited,
  auditable, bounded in lifetime and metadata size, and enabled only for named
  supported clients. It MUST require a declared web or native application type,
  grant no workspace access without later human consent, and MUST NOT require a
  public client to protect a client secret.
- **FR-047**: Consent approval and denial MUST use an authenticated,
  anti-forgery-protected state-changing request bound to the authorization
  transaction and current user. The consent page MUST refuse framing, avoid
  leaking its URL through referrers, prevent sensitive browser caching, and
  require restart or reauthentication if the user, account, session tenure, or
  transaction changes before submission.
- **FR-048**: Radioso's trust model MUST allow a user to authorize an arbitrary
  valid HTTPS metadata-document client within their own live authority after an
  explicit warning that the external client may receive accessible workspace
  data. This feature MUST NOT claim Radioso certification of the client and MUST
  NOT add a workspace domain allowlist or data-class/DLP policy. Deployment-wide
  disablement and owner/administrator revocation remain available.
- **FR-049**: Each descriptor's production MCP disposition MUST be machine
  checked. The coverage gate MUST fail for a missing disposition, incomplete
  eligible metadata, an eligible dashboard-context dependency, unsafe retry or
  effect semantics, a copied/drifted schema, an unknown descriptor, or an empty
  exclusion reason.
- **FR-050**: Grant/category and role authorization MUST be re-evaluated at each
  existing descriptor checkpoint through the intersection evaluator, including
  resolution, reads, effect admission, proposal/evidence persistence, and result
  enrichment. Account-access services MUST remain unaware of descriptors and
  OAuth scopes.
- **FR-051**: An invocation admitted before an authorization change commits MAY
  finish only under its descriptor's declared idempotent/reversible effect
  contract. Changes committed before the descriptor's final pre-effect
  authorization checkpoint MUST prevent the effect. Changes committed after
  that checkpoint do not retroactively undo an admitted effect, but the result
  MUST be reauthorized and suppressed when no longer readable, best-effort
  cancellation MUST be requested, and audit MUST record that completion crossed
  an authorization change. Descriptors whose effects cannot satisfy this
  boundary are ineligible for MCP in this feature.
- **FR-052**: Proposal and evidence persistence for an MCP invocation MUST
  validate grant/category version and current role at its atomic write boundary.
  A stale authorization creates neither a proposal nor evidence. Revoking the
  originating client grant later MUST NOT delete an already-created proposal;
  proposal review, application, dismissal, and retention continue under the
  current dashboard user's permissions and existing proposal policy.
- **FR-053**: Operator invocation receipts and MCP-origin proposal/evidence
  records MUST use the same or shorter retention window as dashboard Ray records,
  cascade safely when their workspace or user ownership is removed, and remain
  distinguishable from customer conversations, Ray conversations, messages, and
  eval case source conversations.
- **FR-054**: A stateful descriptor invocation MUST require a client-generated or
  transport-derived stable operation identity within the grant. The system MUST
  bind it to the descriptor and a bounded, versioned, domain-separated keyed
  digest of canonical validated input, retain only that digest in the
  reconciliation record, reject mismatched reuse, and coordinate concurrent
  duplicates across instances so a lost response cannot multiply effects or
  spend. Raw and canonical input may exist only transiently for validation and
  execution and MUST NOT be retained in reconciliation, invocation, audit, or
  unrestricted error records.
- **FR-055**: The standalone resource MUST validate raw access credentials only
  through the authorization service's validation boundary. Internal capability
  calls MUST use a short-lived service-authenticated proof bound to grant,
  invocation, descriptor, resource, and expiry; the backend MUST revalidate
  authoritative state and reject replay, wrong service, wrong descriptor,
  expired proof, or direct calls. Neither the OAuth credential nor the internal
  proof may be forwarded to external providers.
- **FR-056**: Authorization, grant, role, budget, idempotency, and proposal-origin
  behavior MUST be verified across at least two standalone MCP instances and two
  backend instances, including revoke-then-route-elsewhere, parallel budget
  reservation, duplicate stateful invocation, signing-key mismatch, and partial
  dependency failure.
- **FR-057**: The dashboard MUST provide a client chooser for Codex, Claude Code,
  ChatGPT, and a generic standards-based MCP client, with separate choices where
  a product has materially different surfaces such as Codex CLI, desktop, and
  IDE. Each named choice MUST be generated from a complete, passing, versioned
  Launch Client Matrix setup artifact defining the display version, handoff,
  exact command or configuration template, permitted launch target,
  canonical-resource insertion, expected validated client identity and redirect
  mechanism, and failure/recovery guidance. No artifact means no verified
  handoff. Every artifact uses the deployment's canonical operator resource and
  no reusable Radioso credential. Generic setup MUST be labeled unverified. A
  dashboard choice MUST NOT stand in for OAuth client identification or consent,
  silently invoke a weaker compatibility mechanism, add dashboard-only query or
  state to the canonical resource, remain actionable when operator MCP is
  unavailable, or be labeled connected from UI selection alone. Connection
  state MUST derive from the validated OAuth client identity and grant; any
  setup-to-grant association requires server-verifiable authorization-transaction
  correlation that preserves those identities.

### UI Tasks

- Add an operator MCP connection card that explains the distinction from an
  authored agent's MCP channel and begins client setup without displaying a
  reusable Radioso secret.
- Add an in-product client chooser for Codex, Claude Code, ChatGPT, and another
  MCP client, with unambiguous subchoices for materially different surfaces such
  as Codex CLI, desktop, and IDE. Named clients get versioned artifact-backed
  handoffs or copyable configuration; the generic route is clearly labeled
  unverified and shows standards-based manual setup.
- Add a return state that shows fresh authorized-client inventory records based
  only on validated OAuth client and grant metadata. Do not label the selected
  setup choice as connected or correlate it to a grant without a
  server-verifiable authorization-transaction link.
- Add a browser consent screen showing the requesting client, selected workspace,
  identity origin, redirect host, selected workspace, requested capability
  categories, current user identity, external-data warning, and approve/deny
  actions in an unframeable, anti-forgery-protected flow.
- Add workspace selection when a user can access more than one workspace, and a
  safe no-access state when none is available.
- Add an authorized-client inventory and detail view with status, capability
  categories, creation and recent-use times, and revoke action; owners and
  administrators can also inspect safe workspace-wide grant inventory.
- Add explicit confirmation for revocation and clear states for expired,
  revoked, denied, misconfigured, unavailable, or reconnect-required access.
- Add a conversation-independent proposal review route that reuses the existing
  dashboard proposal card and apply/dismiss behavior for MCP-created proposals;
  do not create a second proposal-review design or synthetic Ray thread.

### Key Entities

- **Operator MCP Resource**: The distinct protected MCP surface that exposes
  eligible operator capabilities and has its own canonical resource identity,
  audience, enablement, policy, and availability state.
- **Operator MCP Grant**: A user's revocable delegation to one client for one
  workspace and one continuous access tenure, bounded by approved capability
  categories and lifecycle state but never granting workspace permissions.
- **Client Identity**: The validated identity, display metadata, redirects, and
  registration mechanism of an MCP host requesting delegated access. It is not
  a Radioso user or service account.
- **Authorization Transaction**: A short-lived, one-time consent attempt binding
  browser state, client, redirect, proof-key challenge, resource, user,
  workspace, and requested categories.
- **Access Credential**: A short-lived, audience-bound credential representing
  an active operator grant. It is not an ordinary API or dashboard session
  credential.
- **Refresh Lineage**: The bounded, rotating family used to renew access while
  the grant, client, user tenure, workspace, and deployment remain valid.
- **Effective Operator Capability**: The deny-only intersection of grant
  categories, current workspace authority, descriptor requirements, current
  catalog eligibility, and Ray safety policy.
- **MCP Descriptor Disposition**: The required reviewed decision for one
  production descriptor: eligible with transport-safe input, context-free
  resolution, retry/effect behavior, and invocation adapter, or excluded with a
  non-empty reason.
- **Operator MCP Invocation**: One attributed tool execution with descriptor,
  user, workspace, client, grant, cost, timing, outcome, and safe audit
  correlation, excluding raw business inputs and outputs from unrestricted
  observability.
- **Operation Reconciliation Record**: A bounded binding between one grant,
  stable operation identity, descriptor, versioned domain-separated keyed input
  digest, reservation, and outcome used to make retries safe across instances;
  it contains neither raw nor canonically serialized tool input.
- **Proposal Origin**: A transport-neutral reference from a proposal and its
  evidence to either a Ray conversation turn or an operator MCP invocation,
  without changing proposal ownership or target-domain semantics.

## Assumptions

- The ordinary dashboard login and workspace membership model remains the human
  authentication source during consent.
- Existing account-access role and permission resolution, including continuous
  access tenure introduced for personal credentials, can be consumed through a
  narrow port rather than duplicated.
- The Operator Copilot production catalog remains the only source of Ray tool
  definitions, governance, permissions, shapes, costs, and never-list policy.
- The current catalog is useful enough to validate external operator workflows
  before remaining Wave 5 breadth is complete; later eligible descriptors can
  join through the same governed adapter.
- Supported MCP clients can open or direct the user to a system browser for
  authorization.
- The operator resource targets MCP `2026-07-28` only. The existing agent MCP
  resource retains its current protocol compatibility and implementation.
- The operator MCP surface is served over public HTTPS outside local development.
- The existing outbound integration OAuth lifecycle may offer low-level
  implementation lessons, but its grants, subjects, storage model, and module
  ownership are not reused as inbound operator authorization semantics.
- This feature is expected to add no new queue handoff, asynchronous document
  job, runtime prompt, customer-facing assistant response, or new kind of
  target-domain mutation. Existing eligible acts may invoke their already-owned
  effects only after the per-descriptor queue and retry review in FR-038.
- A user may authorize any valid HTTPS metadata-document client within their own
  authority after explicit external-data consent. Workspace client allowlists,
  domain policies, and data-class DLP are intentionally deferred.
- An invocation already admitted at its final pre-effect authorization
  checkpoint may complete after a later revocation; revocation prevents the next
  request and suppresses newly unauthorized output rather than promising to
  reverse an effect already committed.
- Product validation will use at least three design partners before general
  availability; lack of design-partner demand may pause broad rollout but does
  not justify weakening the authorization design.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: At least 90% of invited design-partner users can connect a supported
  MCP client to one workspace in under two minutes without copying a Radioso
  secret, and all can identify which workspace and capability categories they
  approved.
- **SC-002**: Authorization and isolation tests show that 100% of tool listings
  and invocations are limited by the user's current workspace authority, grant
  categories, resource audience, client grant, descriptor requirements, and Ray
  deny policy; no cross-workspace or cross-credential-class access succeeds.
- **SC-003**: In demotion, removal, tenure-end, workspace-loss, deployment-disable,
  and revocation tests, effective authority is reduced or denied on the next
  protected request, including when an older catalog or access credential is
  cached by the client.
- **SC-004**: The eligible MCP catalog has 100% machine-checked parity with its
  source Operator Copilot descriptors for name, meaning, schemas, permission
  requirements, shape, capability provenance, cost, output bounds, and never-list
  disposition, retry/effect behavior, and invocation adapter, with a reviewed
  exclusion for every ineligible production descriptor.
- **SC-005**: From each exact build recorded in the Launch Client Matrix—Codex,
  Claude Code, and ChatGPT custom apps—a user can complete discovery, consent,
  tool listing, one read, one probe, one proposal, refresh, role reduction,
  revocation, and reconnect without changing the existing agent MCP
  configuration, using MCP `2026-07-28`. General availability additionally
  proves one named, owner-approved bounded act through the same journey on every
  client; until then rollout remains explicitly limited.
- **SC-006**: In proposal journeys, 100% of MCP-created proposals match the
  dashboard proposal schema, evidence, stale-target safeguards, and audit
  attribution; each uses an MCP invocation origin and conversation-independent
  dashboard review route, no synthetic Ray conversation is created, and none
  changes target-domain state until a separately authorized dashboard user
  applies it.
- **SC-007**: Security tests cover state mismatch, proof-key mismatch, code
  replay, refresh replay, issuer mix-up, open redirect, mutable client metadata,
  server-side request forgery, audience confusion, token substitution, role
  races, cross-workspace access, guessed tools, excessive results, and dependency
  failure, with every case failing closed and returning no protected detail.
- **SC-008**: Across issuance, refresh, invocation, failure, and revocation tests,
  no raw authorization code, access or refresh credential, proof-key verifier,
  session cookie, client secret, prompt, completion, document content, retrieved
  chunk, or unrestricted tool input/result appears in a Radioso-owned persistent
  or observability surface.
- **SC-009**: Every successful grant lifecycle event and representative tool
  outcome is attributable to the correct user, workspace, client, grant, calling
  surface, capability shape, and safe outcome, while authentication floods
  produce bounded low-cardinality operational data rather than unbounded audit
  writes.
- **SC-010**: Existing single-agent MCP contract, security, remote HTTP, Redis,
  and end-to-end smoke suites continue to pass unchanged in both operator-MCP
  enabled and disabled configurations, and the agent surface still exposes only
  `ask_agent`.
- **SC-011**: Under normal operating conditions, 95% of authorization metadata,
  tool-list, and authorization-decision responses complete within one second,
  excluding user interaction and the execution time of the selected operator
  capability.
- **SC-012**: Documentation and dashboard copy allow all three design partners
  to distinguish operator OAuth, ordinary API access, authored-agent MCP access,
  and outbound integration OAuth without implementation-team assistance.
- **SC-013**: Protocol conformance tests verify protected-resource and
  authorization-server discovery, path-specific metadata, Bearer challenges,
  four tool-scope parsing, independent `offline_access` consent and denial,
  `resource` in authorization and token requests, S256 proof key, issuer
  binding, Bearer-header-only transport, exact audience validation, and `401`
  versus `403` behavior under MCP `2026-07-28`.
- **SC-014**: Client security fixtures cover HTTPS metadata identity, exact
  self-match, web redirects, IPv4 and IPv6 loopback redirects with variable
  ports, rejected `localhost`, rejected unregistered private schemes, metadata
  mutation, redirects, DNS rebinding, oversized responses, timeouts, and bounded
  compatibility registration for every named supported client.
- **SC-015**: Across two standalone and two backend instances, 100% of
  revoke-then-route-elsewhere requests are denied, parallel reservations never
  exceed six grant verification-cost units per rolling minute, and repeated or
  concurrent stateful operation identities produce one cost and one effect or
  one safely reconciled prior result.
- **SC-016**: Authorization-race tests prove that a change before the final
  pre-effect checkpoint prevents the effect; a change after that checkpoint may
  allow only an already-admitted eligible effect to complete, suppresses output
  the user may no longer read, requests best-effort cancellation, and records
  the crossed authorization change without sensitive content.
- **SC-017**: Refresh concurrency tests prove that exactly one request can
  consume a current refresh generation; presentation of that consumed
  generation by any losing concurrent request or lost-response retry revokes the
  full lineage, makes any concurrently returned successor unusable, and requires
  interactive reauthorization without reviving the prior grant lineage.
- **SC-018**: At least 90% of design-partner users starting only in the Radioso
  dashboard can choose their preferred launch client surface, use its exact
  passing setup artifact to add the canonical operator MCP resource, complete
  browser authorization, and identify the fresh grant by its independently
  validated client identity in under two minutes without consulting external
  Radioso documentation or copying a reusable Radioso credential. Across tests,
  100% of named handoffs have a complete fixture for the displayed surface and
  version, 100% of generic-client journeys are visibly labeled unverified, and
  no dashboard selection is reported as connected without a validated grant.
