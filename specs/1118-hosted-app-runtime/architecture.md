# Architecture: Radioso Hosted App Runtime

**Status**: Draft companion to [Hosted App Runtime specification](./spec.md)  
**Date**: 2026-09-06  
**Scope**: The stable App abstraction and a Radioso Cloud-hosted execution option. Provider selection and implementation tasking belong in the later plan.

## 1. Architectural Thesis

Radioso should extend product behavior through **typed contributions**, not arbitrary hooks and not code imported into core processes.

An **App** is the independently versioned, installed, permissioned, and operated extension unit. An App Release declares contributions. An App Installation binds one immutable release to one workspace, connections, grants, storage, and selected agents or UI surfaces. A **Pack** is optional declarative agent configuration distributed by an App; it is not the executable runtime or authority boundary.

Radioso Cloud hosts approved App code in an installation-isolated sandbox. The App communicates through a versioned runtime protocol and narrow host capabilities. It cannot access Radioso databases, internal networks, route tables, process memory, frontend runtime, or general APIs.

The design has two tests:

1. A WordPress-, Magento-, or Notion-shaped App can add content synchronization and runtime actions without core product special cases.
2. A CSAT-shaped App can add an end-user control, managed state, events, and an operator view without importing frontend code or declaring database tables.

If an App needs a behavior outside the published contribution catalog, Radioso adds a new reviewed semantic contribution type. The App never invents its own host hook.

**One architecture.** Apps that Radioso authors are ordinary Workspace Apps. They use the same manifest, App Gateway, runtime protocol, host capabilities, and Managed App Storage as any third party, and they run under the runtime provider. There is no in-process or "built-in" App path. The first such App is WordPress, which replaces the in-process WordPress connector in Release A. The only thing that differs between deployments is the runtime provider implementation behind one port: a local-process provider for development and self-hosted stacks, a sandbox provider for Radioso Cloud. Admission, egress, and sandbox hardening tighten inside their ports; they never open a second execution path.

### Existing substrate and missing platform boundary

| Existing Radioso seam | What is already usable | What this architecture adds or deliberately keeps separate |
|---|---|---|
| Agent skills and capability/executor registries | Per-agent named tools, invocation modes, typed bindings/outcomes, capability policy, routine references | A data-driven App tool descriptor and executor adapter; Apps do not create a second agent tool model. |
| External MCP skills | Workspace-connected external tools behind existing skill policy | Remains a tool transport option, not the App lifecycle or hosted execution protocol. |
| Routines, directives, and portable agent bundles | Declarative behavior, versioning, conflict handling, and portability concepts | Optional Packs reuse those semantics but remain separate from App runtime authority. |
| Document APIs and asynchronous worker | Guarded document ingestion, processing state, parsing, chunking, and embedding | Document-source contributions enter through a documents-owned port; App Jobs do not reuse document job rows or payloads. |
| OAuth/connections, webhooks, audit, and activity traces | Credential binding and established accountability/diagnostic patterns | Installation-scoped Connections, public App webhook admission, field-level egress disclosure, and App-specific event families. |
| `ApplicationModule` composition and `ConnectorPlugin` contracts | Deployment-trusted registration of concrete infrastructure and connectors | Used for host wiring only; never exposed as workspace-installable App authority. |
| Frontend component system | First-party dashboard and conversation surfaces | Semantic slot hosts and isolated frames; no third-party React/component imports. |
| PostgreSQL system of record | Durable workspace state, transactions, deletion, and backup policy | Generic namespaced App collections and App Jobs; no App-authored tables or migrations. |

What is missing today is the layer that makes these seams one installable, signed, permissioned, versioned, observable, and reversible unit. This design adds that layer without collapsing the existing domain boundaries into a generic plugin API.

## 2. Decisions

| Decision | Consequence |
|---|---|
| App is the primary extension unit | Identity, releases, permissions, health, updates, quarantine, and removal are coherent across all contributions. |
| Contributions are a closed discriminated catalog | Core modules integrate through stable product concepts rather than App IDs or generic callbacks. |
| Hosted execution is out of process | Third-party failure and supply-chain risk do not enter API, worker, or frontend processes. |
| One workspace installation per sandbox | No sandbox ever receives two workspaces' credentials or data; cost is controlled with scale-to-zero. |
| Apps declare logical storage, not tables | PostgreSQL schema, migrations, backup, and availability stay owned by Radioso. |
| Network egress is mediated | Destination, credential, rate, and data policy are enforced at call time rather than trusted to App code. |
| App UI is framed and capability-scoped | Third-party JavaScript cannot access dashboard DOM, cookies, or general API authority. |
| Runtime activation is pointer-based | Candidate and rollback releases can coexist without partially visible contributions. |
| Async App work has its own durable job contract | Events, schedules, and webhooks do not leak into document-worker payloads or synchronous transactions. |
| Packs remain separate | Installing runtime capability never silently rewrites agent behavior. |
| Trusted modules remain separate | Existing application modules and connector plugins retain deployment-level power for infrastructure and channel connectors without defining marketplace trust. They are never used to implement Apps. |
| First-party Apps use the same architecture | Radioso-authored Apps prove the protocol; no core module gains an App-specific branch, and hosting is a provider choice rather than a trust tier. |
| One runtime protocol, many providers | The local-process provider and the Cloud sandbox provider implement one port; App code and product domains cannot observe which is active. |

## 3. System Context

```text
                          RELEASE CONTROL PLANE

 App publisher ──▶ Release admission ──▶ Immutable artifact registry
                         │                         │
                         │ policy/signature        │ release digest
                         ▼                         ▼
                   Security/revocation      Installation planner


                         INSTALLATION CONTROL PLANE

 Workspace admin ──▶ Install/approve/bind/test/activate lifecycle
                              │
                 ┌────────────┼─────────────┐
                 ▼            ▼             ▼
              Grants      Connections   Contribution ownership
                 │            │             │
                 └────────────┴──────┬──────┘
                                     ▼
                              Active release pointer


                            RUNTIME DATA PLANE

 Chat / routines / documents / events / UI
                    │
                    ▼
           Product-owned contribution ports
                    │
                    ▼
               App Gateway
          ┌─────────┼───────────┐
          ▼         ▼           ▼
   Sandbox pool  App Storage  Egress/secret broker
          │                     │
          ▼                     ▼
  Per-install runtime      Approved external service
```

The control plane decides what may exist and be active. The data plane executes already-approved contributions. Runtime requests cannot mutate grants, expand destinations, install releases, or reinterpret manifests.

## 4. Trust Classes

### Workspace App

- Installed by a workspace administrator from an admitted release.
- Runs through a provider-neutral gateway in a Radioso-hosted sandbox in the initial program.
- Uses App Gateway, managed storage, and narrow host capabilities.
- Has no SQL, migration, host-route, process, or imported-UI authority.

### Trusted deployment module

- Installed by the deployment operator as part of the Radioso deployment.
- May register application modules, connector plugins, storage providers, queues, routes, or migrations under existing architecture rules.
- Is reviewed and operated as part of the host deployment, not through workspace App installation.

These classes must not share an “advanced permission” toggle. Workspace administrators cannot promote an App into a trusted module.

Radioso-authored Apps belong to the Workspace App class. Authorship grants no extra authority. The `ConnectorPlugin` contract remains the trusted path for channel connectors (Slack, WhatsApp), which the App catalog excludes; it registers no document-source connectors once the WordPress connector is retired.

## 5. Module Ownership

### `apps` domain

**Knows**:

- App and publisher identity.
- Immutable releases and admission decisions.
- Installation plans, grants, connections, attachments, contribution declarations, active/prior release pointers, lifecycle, and data disposition.
- Which owning-module ports must be called to stage or detach a contribution.

**Does not know**:

- Container or cluster APIs.
- Private runtime transport.
- Product-specific execution details.
- SQL implementation of other modules.
- React, iframe rendering, or external provider protocols.

**Exposes**:

- Release inspection/admission reads.
- Deterministic installation planning.
- Lifecycle commands with optimistic version and idempotency keys.
- Current installation/grant/attachment resolution.
- An `AppExecutionEligibility` query port that returns the current release, lifecycle, quarantine/revocation, grant, attachment, connection, and contribution eligibility for one attempted operation.
- Activation policy for mapped contribution-owned entities.
- Narrow ports for Ray, HTTP, SDK, and operator UI consumers.

### `appRuntime` domain

**Knows**:

- Runtime instances, sandbox desired/observed state, invocation envelopes, deadlines, budgets, cancellation, health, circuits, and App Jobs.
- The versioned App Runtime Protocol.
- The installation/release/contribution requested for execution and the eligibility decision returned for that attempt by the Apps-owned query port.

**Does not know**:

- How an agent chose a tool.
- Routine graphs, retrieval policy, document business rules, or UI layout.
- Installation product decisions or publisher admission rules.
- Concrete sandbox, broker, or cluster provider APIs.

**Exposes**:

- Synchronous contribution invocation port.
- Durable App-job admission and cancellation ports.
- Runtime readiness/health projection.
- Sandbox provider, dispatcher, consumer, identity issuer, and egress ports for composition.

### `appStorage` domain

**Knows**:

- Installation-scoped logical collections, record schemas, schema compatibility, quotas, optimistic versions, declared indexes and queries, expiry, export, retention, and deletion.

**Does not know**:

- App business meaning.
- Physical tables declared by Apps; there are none.
- Conversation, document, or routine internals.
- Sandbox provider details.

**Exposes**:

- Scoped record read/write/delete/query operations.
- Collection compatibility checks used by release admission and update planning.
- Storage usage, export, retention, and deletion operations.

### Product contribution owners

| Contribution | Owning domain | Narrow responsibility |
|---|---|---|
| Tool | Skills / agent skills | Projects an installed App tool into a named skill and dispatches through the executor registry. |
| Context provider | Chat context | Requests a bounded typed value under declared scope, sensitivity, cache, and deadline policy. |
| Document source | Documents | Accepts sanitized, provenance-tagged ingest/delete operations through existing document and worker flows. |
| Event subscription | Event-owning module + App runtime | Emits a versioned public projection after commit; App runtime owns fan-out and delivery. |
| External webhook | App runtime | Authenticates and durably admits public input before App execution. |
| Scheduled task | App runtime | Creates bounded logical occurrences and jobs under overlap policy. |
| UI contribution | Frontend App host | Renders a semantic slot and grants a bounded bridge session. |
| Pack | Agent Pack domain | Plans and applies declarative agent configuration through owning services. |

Product domains never call a sandbox provider directly. They depend on contribution-specific ports adapted to the generic App runtime invocation boundary.

The gateway, App-job consumer, UI-session issuer, storage capability, egress broker, and schedule/event/webhook admission paths consume `AppExecutionEligibility` immediately before granting authority. The Apps domain owns the rules and authoritative reads; callers fail closed on an unavailable or indeterminate decision and do not cache a positive decision beyond that operation.

### Application composition

Composition selects and assembles:

- Release and artifact adapters.
- Admission, signature, provenance, and revocation providers.
- Sandbox and runtime-network provider.
- Secret broker and egress implementation.
- App Storage repository and optional object storage.
- App-job dispatcher and consumer.
- Contribution adapters into skills, chat context, documents, events, and UI-session APIs.
- Observability and audit sinks.
- Disabled/no-op defaults.

Composition owns no lifecycle, permission, compatibility, retry, or data policy.

## 6. Dependency Direction

```text
HTTP / SDK / Ray / Dashboard
             │
             ▼
          apps domain ─────────────▶ owning-module contribution ports
             │                                  │
             │ authorized execution             │ existing domain behavior
             ▼                                  ▼
       appRuntime domain                   Skills / Chat / Documents
          │       │
          │       └──────────▶ appStorage domain
          ▼
 sandbox / identity / egress / queue ports
          ▲
          │
     composition adapters
```

Broad knowledge depends on narrower contracts. Product domains do not import `apps`, manifests, or provider implementations. `apps` orchestrates through their public ports. Provider adapters never own App product decisions.

The existing shared `backend/src/shared/agent-runtime/` is not part of this graph. It remains a stateless LLM tool-calling loop. Hosted App Runtime is an installation-scoped execution and job system with no implicit LLM authority.

## 7. Shared Contract Package

A small provider-neutral contract package should be the canonical source for:

- Manifest and release-envelope schemas.
- Contribution discriminated unions.
- App Runtime invocation/request/result envelopes.
- Public App event envelopes.
- App Job wake-up envelope.
- Storage declaration and scoped operation schemas.
- UI slot declarations and bridge messages.
- Conformance vectors and compatibility rules.

It must contain data schemas and pure validation only. It must not import backend modules, persistence, sandbox SDKs, provider clients, UI frameworks, or product services.

Generated OpenAPI and App SDK surfaces may consume this package, but it does not replace the code-first HTTP registry.

### Runtime protocol boundary

The protocol is a versioned logical interface rather than a promise of a particular container, RPC framework, or cloud provider. An admitted artifact implements:

```text
health() -> readiness + implemented contribution IDs

invoke({
  protocolVersion,
  invocationId,
  installationId,
  releaseDigest,
  contributionId,
  executionClass,
  inputSchemaVersion,
  input,
  deadline,
  idempotencyKey?,
  capabilitySession
}) -> {
  protocolVersion,
  invocationId,
  outcome,
  outputSchemaVersion?,
  output?,
  retryHint?,
  checkpoint?
}
```

The gateway, not the artifact, supplies identity and authoritative context. The artifact cannot select a different installation, contribution, schema, deadline, or capability set. `outcome` is a closed catalog separating success, invalid request, denied, unavailable, rate-limited, retryable failure, terminal failure, timeout, and cancellation. App-authored text is untrusted data inside declared output fields, never a host error or assistant response.

The `capabilitySession` is an invocation-scoped handle used for separately versioned host operations such as managed storage, approved egress, and declared UI commands. Each host operation validates its own narrow request schema and rechecks current grants. No generic “call Radioso API” capability exists.

Transport adapters may use private HTTP, RPC, or another framed protocol, but they must preserve the same envelopes, cancellation, deadlines, response-size limits, and conformance vectors. App authors target the logical protocol through an SDK; provider wiring remains internal.

## 8. Release Model

An App Release is immutable:

```text
AppRelease
  appId
  version
  manifestSchemaVersion
  runtimeProtocolVersion
  publisherId + signingKeyId
  executableDigest
  optional uiAssetDigest
  radiosoCompatibilityRange
  contributions[]
  configurationSchema
  permissions[]
  destinations[]
  egressFields[]
  storageCollections[]
  resourceProfile
  conformanceFixtures[]
  provenance + software inventory
  admissionPolicyVersion + decision
```

Release states:

```text
submitted → validating → admitted
     │           │           │
     │           └──────▶ rejected
     │
     └──────────────────▶ withdrawn

admitted ──▶ deprecated
    │
    ├──────▶ revoked
    └──────▶ quarantined
```

An admitted release may be installed. A deprecated release remains available to existing installations but is not offered for new installation. Revoked or quarantined releases cannot start new execution. Rollback eligibility is rechecked against current admission and compatibility policy.

### Admission policy

The admission result records the policy version and evidence summary. The initial preview requires:

- Approved publisher key and valid signature.
- Immutable executable and UI digests from approved registries.
- Verified build provenance and parseable software inventory.
- No vulnerability prohibited by the current preview policy.
- Supported manifest/runtime versions and Radioso compatibility.
- Bounded resources, schedules, storage, schemas, destinations, and UI declarations.
- Successful conformance for every contribution.

There is no workspace-level bypass. New install/update/rollback fails closed when current signature, policy, or revocation status cannot be established. Existing admitted installations continue through a registry outage under their last valid decision; explicit revocation or quarantine is propagated to runtime admission within the specified security window.

## 9. Contribution Model

Every contribution has a common header:

```text
id
kind
display metadata
required permissions
execution class
input/output schema versions
deadline and resource bounds
failure semantics
data classes and egress
availability requirement
conformance fixture
```

The contribution `kind` selects a closed schema. Unknown kinds fail release admission.

### Tool projection

An App tool is not directly presented to an agent. Attaching it creates a normal named agent skill through the agent-skills service:

```text
App installation + contribution ID
                 │
                 ▼
App tool capability descriptor
                 │
                 ▼
agent_skills record
  unique agent skill name
  explicit invocation mode
  bound/exposed typed inputs
  declared structured outcomes
  enabled state
  target = installation/contribution
                 │
                 ▼
SkillExecutorRegistry adapter → App Runtime invocation
```

This retains current routine/directive behavior and diagnostics. A missing, disabled, unhealthy, revoked, or detached App target makes the skill unavailable through existing typed failure and reference visibility rules. Packs refer to the named skill while retaining the required App/contribution identity for portability and update diagnostics.

### App configuration

Configuration is manifest metadata, not an executable contribution. The App domain owns a declarative schema using a bounded field vocabulary. Secret and OAuth fields are Connection slots rendered through write-only credential flows. Generic UI renders ordinary fields; richer configuration may use a sandboxed App-detail UI, but authoritative validation stays server-side.

## 10. Installation Model

```text
planned → provisioning → staged → testing → ready → active
   │            │           │        │        │       │
   └────────────┴───────────┴────────┴────────┴──▶ failed

active → disabled → active
active → updating → active
active → rolling_back → active
active → quarantined
active/disabled/quarantined → removing → removed
```

An installation records:

- Workspace and App identity.
- Candidate, active, and eligible prior release pointers.
- Approved grants and their source plan.
- Connections and agent/surface attachments.
- Staged and active contribution mappings.
- Configuration version.
- Runtime desired/observed state and health summary.
- Circuit and degradation state.
- Managed storage disposition.
- Optimistic version and current lifecycle operation.

### Plan/apply boundary

Inspection validates a release without mutation. Planning resolves the exact workspace, selected agents, connection bindings, contributions, grants, external destinations, field-level egress, storage, UI slots, Packs, conflicts, and current versions. The result has a checksum and expiry.

Apply accepts that checksum, an idempotency key, and expected versions. Any relevant change invalidates the plan. Every protected step rechecks the current principal before starting a new privileged effect. System-owned safety or compensation work may finish after access loss; it cannot add authority.

### Lifecycle saga

Installation is a durable saga rather than a transaction spanning domain services:

1. Create installation and operation records.
2. Persist approved grants and connection bindings.
3. Ask the runtime provider to provision the candidate release.
4. Ask owning modules to create staged contribution projections through narrow ports.
5. Register staged storage schemas and UI assets.
6. Run conformance and installation-specific safe tests.
7. Record ready state.
8. Atomically move the installation's active release pointer.

Every step has an idempotency key and compensator where reversal is safe. A crash resumes from the durable cursor. Compensation never guesses at a partial external side effect.

### Atomic runtime visibility

Contribution-owned entities map to an immutable installation release revision. An `AppActivationPolicy` filters mapped skills, routines, directives, context providers, schedules, event subscriptions, webhook handlers, and UI contributions:

- Unmapped native entities follow normal product lifecycle rules.
- Mapped entities are usable only when their release revision equals the active pointer and the installation is active.
- Staged, disabled, removed, quarantined, or indeterminate mappings fail closed.
- A policy/storage failure denies mapped or indeterminate entities and reports degradation.

Activation changes one pointer in App-owned persistence. Product records need not be updated together.

## 11. Hosted Runtime Topology

```text
                    Radioso Cloud private network

 Product adapter ─▶ App Gateway ─▶ Runtime provider ─▶ Installation sandbox
                        │                 │                    │
                        │                 │                    ├─ immutable root
                        │                 │                    ├─ bounded scratch
                        │                 │                    ├─ one installation
                        │                 │                    └─ no public listener
                        │                 │
                        │                 └─ provision/start/stop/drain/health
                        │
                        ├─ installation identity issuer
                        ├─ schema and deadline enforcement
                        ├─ App Storage capability
                        ├─ egress/secret broker capability
                        └─ safe telemetry
```

The runtime provider is replaceable. The App protocol must not expose Kubernetes, container, function, VM, or cloud-provider concepts. Two providers implement the port:

- **Local-process provider** (Release A, reference implementation). Runs one App process per installation, packaged as a Compose service beside the document worker for development and self-hosted deployments. The provider starts and stops the process, passes only the installation identity and gateway address, and reports health and drain state. It enforces the protocol and grant checks fully; OS-level isolation is whatever the host container gives.
- **Sandbox provider** (Release E). Adds the immutable root, bounded scratch, restricted system calls, scale-to-zero, and per-installation quotas listed below for Radioso Cloud.

A deployment with no provider registered still builds and serves; installed Apps report unavailable. The same App artifact runs on either provider with identical conformance results.

### Sandbox isolation

Each sandbox contains one App Installation. It may serve multiple invocations for that installation until drained or idle. It cannot depend on local state surviving stop or update.

Required restrictions:

- Immutable executable filesystem.
- Bounded ephemeral scratch.
- Non-root identity and restricted system calls.
- No host namespaces, sockets, container control, metadata service, or internal service discovery.
- No direct database, Redis, broker, object-storage, or secret-store credentials.
- No inbound public listener; App Gateway owns ingress.
- Deny-by-default external network path mediated by the egress capability.
- Per-installation CPU, memory, concurrency, duration, response, scratch, and aggregate quotas.

### Runtime identity

The gateway issues a short-lived identity bound to:

```text
workspace
installation
active release
contribution
invocation/job
execution class
approved host capabilities
deadline/expiry
```

Host APIs re-read current installation, grant, release, and quarantine state. A token is necessary but never sufficient after disable or revocation.

## 12. Synchronous Invocation

```text
Agent/routine
  │ invokes named skill
  ▼
Skill executor adapter
  │ resolves current target + activation + grant
  ▼
App Gateway
  │ admits rate/concurrency; issues invocation identity
  ▼
Runtime provider starts/reuses installation sandbox
  │
  ▼
App handler
  │ optional scoped storage/egress calls
  ▼
Gateway validates response and discards late/cancelled results
  ▼
Typed skill outcome + safe activity trace
```

Context providers use the same path with shorter budgets, bounded results, cache policy, and explicit optional/required absence behavior. An App cannot convert an interactive or context request into detached background work.

## 13. Durable App Jobs

Asynchronous execution uses PostgreSQL as the authoritative state. A broker, when configured, only accelerates wake-up.

```text
Source event / schedule / public webhook
                 │
                 ▼
        durable AppJob admission
                 │
                 ├──▶ optional queue: { envelopeVersion, appJobId }
                 │
                 ▼
        consumer reloads current state
                 │
                 ▼
       compare-and-set lease + invoke
                 │
         ┌───────┴────────┐
         ▼                ▼
   complete/ack      retry/dead-letter
```

An App Job records contract version, job and source identity, workspace, installation, release, contribution, execution class, safe input reference, idempotency key, schedule/event schema versions, availability, deadline, attempt ceiling, lease, cancellation, checkpoint, and safe outcome.

Rules:

- Queue envelopes contain only the job ID and envelope version.
- Consumers recheck active release, grants, cancellation, quarantine, and contribution compatibility before lease.
- Lease acquisition and completion are compare-and-set operations.
- Backoff, jitter, maximum attempts, lease extension, dead-letter, and retention are bounded per execution class.
- Handler acknowledgement occurs only after accepted host effects and job completion are durable.
- Every attempt receives the same logical idempotency key, and host capabilities receive it on effect requests. Radioso-owned effects deduplicate when the capability contract promises that behavior. External provider effects are explicitly at-least-once unless that provider offers an idempotency mechanism; the App owns correct use of that mechanism and checkpoints only after the effect is known durable.
- Disable/quarantine stops unleased work; late results are discarded.
- Source-event fan-out is idempotent on event ID plus installation plus contribution.
- Schedule admission is idempotent on logical occurrence and applies skip/queue/replace overlap policy.

App jobs have a separate queue namespace and payload contract from document processing. They may reuse a transport adapter but not document job rows, retry rules, or payloads.

## 14. Events And Public Webhooks

### Outbound App events

Owning modules define versioned public event projections. They do not expose internal records. The source mutation commits before fan-out becomes eligible. Subscription resolution creates one installation-specific job per approved subscriber.

Payload projections are explicit about identifiers, optional fields, sensitivity, and size. Adding a field does not automatically expose it to existing subscriptions or grants.

### Inbound external webhooks

App Gateway owns the public endpoint and performs:

- Installation/contribution routing without granting trust to a URL alone.
- Signature or connection-specific authentication.
- Timestamp/replay validation.
- Source and request-rate admission.
- Header/body/type/size validation.
- Idempotent durable App-job creation.

App code does not run in the public HTTP request. Unsupported or removed installations do not wake a sandbox.

## 15. Network And Secret Boundary

Apps request external access as named destinations and Connection slots. The install plan shows protocol, host pattern, port, purpose, data classes, and credentials involved.

```text
App handler
   │ scoped fetch request + connection handle
   ▼
Egress broker
   ├─ current grant check
   ├─ destination and redirect validation
   ├─ DNS/public-address validation at connect time
   ├─ rate/size/deadline policy
   ├─ short-lived credential exchange or injection
   └─ safe accounting
   ▼
Approved external endpoint
```

Durable credentials remain in Radioso's secret store. The sandbox receives opaque handles and, only where unavoidable, narrowly scoped short-lived provider material. Neither form grants a direct path to the secret store.

The broker denies loopback, link-local, private, metadata, cluster-internal, and unapproved destinations. Destination approval does not bypass current DNS, redirect, or network policy.

## 16. Managed App Storage

Apps declare logical collections:

```text
collection ID
scope
record schema version
compatible reader versions
bounded scalar indexes
allowed query/filter/sort operations
record and collection quotas
expiry and retention policy
```

The physical model is Radioso-owned generic storage. App install/update never runs App-specific DDL, creates physical App tables or indexes, or executes App transaction code.

A possible adapter may use generic records and generic index entries:

```text
AppStorageRecord
  workspaceId + installationId + collectionId + recordKey
  schemaVersion
  value
  optimisticVersion
  expiresAt

AppStorageIndexEntry
  record identity
  declared index ID
  bounded scalar value
```

That physical choice is replaceable and not exposed to Apps.

Release validation computes a compatibility matrix for active, candidate, queued-job, and rollback releases. The initial policy accepts backward-compatible additive schemas and rejects arbitrary/destructive migrations. Queued jobs retain their input schema version and can run only on a declared compatible release.

Complex relational or high-volume domain data belongs in disclosed App-owned external storage reached through approved egress. Installation UI must distinguish managed regional storage from external storage.

Disable and quarantine revoke storage API access without deleting data. Uninstall first revokes runtime authority, then applies an operator-selected export, bounded retention, or deletion disposition. Workspace deletion includes App storage, jobs, secrets, identities, and UI sessions.

## 17. UI Architecture

```text
Radioso page
  └─ semantic App slot host
       ├─ loading/error/degraded boundary
       └─ sandboxed frame from immutable asset origin
              │ postMessage bridge
              ▼
         UI session gateway
              ├─ origin/session/slot/entity/grant validation
              ├─ bounded context projection
              └─ declared command dispatch to App runtime
```

The initial slots prove two categories:

- End-user control after an assistant message.
- Operator App detail/report view.

Slots expose versioned context and command catalogs. Frames receive no dashboard cookies, parent DOM, arbitrary navigation, general API token, or undeclared conversation/workspace data. Each UI session is short-lived, entity-scoped, and rechecks current grants. App failure never replaces the host page's navigation or primary action.

UI assets are served from a cookie-isolated origin distinct from Radioso dashboard and API origins. Dashboard cookies are host-only and never sent to that origin. The default frame sandbox omits same-origin privilege, top navigation, popups, downloads, and storage-access grants; the frame CSP denies undeclared connections and navigation. Asset/subresource credential behavior, redirects, origin checks, and any slot-specific browser capability are enforced and covered by malicious-frame conformance tests.

## 18. Updates, Rollback, And Quarantine

Candidate release provisioning occurs beside the active release:

1. Re-run current admission and compatibility policy.
2. Diff contributions, grants, destinations, egress, configuration, storage, UI, resource profile, and Packs.
3. Require re-approval for widened authority.
4. Provision candidate sandbox and stage candidate mappings.
5. Check storage/job/rollback compatibility.
6. Run conformance and installation-specific safe tests.
7. Atomically change the active release pointer.
8. Drain the old runtime; retain it as an eligible rollback artifact according to policy.

Rollback repeats current security, grant, compatibility, and data checks. It never restores revoked credentials or permissions merely because an old release used them.

Quarantine is a reversible platform safety state applied to a release. Revocation is a stronger release-admission decision that may permanently forbid reactivation or rollback. Both states block invocation, job leasing, storage access, UI-session issuance, schedule admission, event fan-out, and webhook dispatch. Neither deletes configuration or customer data by itself.

## 19. Pack Relationship

A Pack may be listed within an App Release, but has a separate plan/apply/activate lifecycle. It reuses portable agent and agent-bundle principles:

- Contents and references are versioned and secret-free.
- Workspace-bound references become explicit connection/App contribution requirements.
- Unresolved references are reported, never silently dropped.
- Existing operator-authored elements are not overwritten without an explicit conflict decision.
- Pack-owned elements retain provenance and ownership for disable, update, detach, and removal.
- Import/install audit events record identities and counts, never instructions or content.
- A Pack referencing a removed or incompatible App contribution becomes degraded/inactive rather than redirecting to another capability.

Installing an App never implicitly installs or activates its Packs.

## 20. Capacity And Admission

Admission is enforced at multiple bounded scopes:

- Request source and principal.
- Workspace/account.
- App publisher and release.
- Installation.
- Contribution and execution class.
- Sandbox fleet and provider capacity.
- Public webhook source and endpoint.
- App-job queue depth and worker concurrency.
- UI-session creation and command rate.
- Storage records, bytes, indexes, query cost, and result size.

When provider or fleet capacity is unavailable, admission fails quickly with retry guidance for asynchronous work and a typed unavailable result for synchronous work. It does not start unbounded provisioning or queue growth. Noisy-neighbor tests must show that one installation exhausting its allocation does not consume another installation's reserved admission budget.

## 21. Observability

### Audit event families

- `app.release.*`: submitted, admitted, rejected, deprecated, revoked, quarantined.
- `app.installation.*`: planned, installed, tested, activated, disabled, updated, rolled_back, removed.
- `app.grant.*` and `app.connection.*`: approved, changed, revoked, rebound.
- `app.data.*`: export requested/completed, retention changed, deletion requested/completed.
- `app.security.*`: admission denied, policy changed, execution denied, quarantine changed.

Audit metadata contains actor, workspace, App/release/installation/contribution identities, policy and plan versions, counts, reason codes, and outcomes—but no manifest content, payloads, credentials, or customer content. Retention and access follow the existing audit policy.

### Logs and traces

Safe identifiers may appear as structured correlation fields in access-controlled logs, traces, and audit records. Invocation spans cover gateway admission, sandbox acquisition, handler time, storage/egress child calls, response validation, and result disposition. Sampling must retain all failures/security denials and may sample successful high-volume execution according to the existing observability policy.

### Metrics

Metrics use bounded labels only: contribution kind, execution class, outcome, retry class, circuit state, admission reason, sandbox state, and compatibility result. Workspace, App, release, installation, contribution, invocation, job, record, and user identifiers are prohibited as metric labels.

Required measures include admission count, platform overhead, cold/warm start, handler duration, timeout/cancellation, sandbox capacity, queue age/depth, attempts/dead letters, circuit transitions, storage quota/query outcomes, egress denials, UI failures, and lifecycle duration/outcome.

## 22. Public Contracts And Existing Surfaces

- App release, installation, planning, lifecycle, storage, and operational APIs are registered in the code-first backend OpenAPI source.
- Generated `backend/openapi.yaml` and `backend/openapi.json` and the TypeScript SDK snapshot are regenerated together.
- The TypeScript SDK receives ergonomic App resources over the generated contracts.
- The standalone Radioso MCP server does not gain App administration or direct App tool-list endpoints in this program. Its existing `ask_agent` conversation may indirectly use an attached App-backed named skill under normal agent policy. MCP package contract/build/smoke impact is still reviewed and documented.
- Ray contributes read/propose/apply tools only where the owning operation is safe for delegated operator use. Every descriptor declares public operation/owning primitive provenance, permission parity, confirmation, and target scope. Exclusions are recorded in the maintained coverage map.
- Operator docs, App-author docs, security/runtime docs, SDK docs, and architecture/code-map entries ship with the corresponding release slice.

## 23. Conformance Architecture

A shared conformance harness exercises the public manifest, runtime, storage, UI bridge, and host-capability contracts. It is App-identity-neutral: fixture behavior is selected by declared contributions, never by checking an App ID.

| Persona fixture | Required contributions and boundaries |
|---|---|
| WordPress/WooCommerce | Declarative site connection; document source with stable external IDs; scheduled incremental cursor; authenticated `post.updated` webhook; live `get_order` named skill; approved public-site egress; lightweight cursor/mapping collection. |
| Magento | Commerce connection; product/order tool schemas distinct from WordPress; catalog document source; product/order event subscription or webhook; failure and rate-limit outcomes; no new contribution kind. |
| Notion | OAuth connection; scheduled document source; pagination/checkpoint state; deleted-page propagation; token revocation and reauthorization; no vendor-specific ingestion route. |
| CSAT | Assistant-message UI slot; scoped submit command; feedback collection; operator App view; storage export/delete; no imported React component or core feedback table. |

Release A uses the WordPress App itself as the reference App: connection, document source, webhook handler, scheduled poll, and a cursor collection over the full protocol on the local-process provider. Its live `get_order` tool arrives with the tool contribution in Release B. Later persona fixtures are introduced only with their release gate.

### WordPress connector retirement

The in-process WordPress connector (`backend/src/modules/connectors/plugins/wordpress/`) and the WordPress-specific dashboard branches are replaced, not wrapped:

| Today | Release A |
|---|---|
| `ConnectorPlugin` registered in the connector registry | App release in the built-in registry, installed per workspace |
| `connector_configs` row with encrypted secrets | App Installation plus Connection (site URL, application password, webhook secret) and non-secret configuration |
| `connector_sync_state` cursor and locks | Managed App Storage collection owned by the App; leases owned by App Jobs |
| Own route `POST /api/connectors/wordpress/:workspaceId/webhook` | Installation-scoped gateway webhook endpoint; the legacy path forwards with the same secret for a deprecation period |
| In-process polling loop | Scheduled-task contribution producing App Jobs |
| Direct `ConnectorIngestionPort` calls | Document ingest and delete host capabilities through the gateway |
| Raw HTTP client to the site | Mediated egress fetch with a connection handle |
| Hardcoded menu item, setup guide, download link in the frontend | Generic Apps catalog, manifest-declared setup guide and companion asset |

Migration is a per-workspace, idempotent, resumable operation. It creates the installation, connection, and cursor record from the existing configuration, keeps ingested documents' external IDs and provenance so the App's next sync updates rather than duplicates, and switches the workspace only when every step succeeds. The PHP companion plugin needs no change to keep working; the dashboard shows the new endpoint for new installs.

## 24. Failure Matrix

| Failure | Required behavior |
|---|---|
| Release signature/provenance invalid | Reject before provisioning. |
| Registry unavailable | Fail new admission closed; active admitted installations continue unless explicitly revoked/quarantined. |
| Sandbox capacity unavailable | Fail synchronous admission quickly; keep bounded async work eligible for retry. |
| Cold-start or health failure | Mark installation/runtime degraded; do not activate candidate. |
| Handler timeout/crash | Typed failure; discard late result; update circuit. |
| Invalid handler response | Reject as untrusted data; typed failure; safe trace. |
| Egress destination denied | No network call; security audit reason; contribution failure. |
| Secret revoked | Current grant/connection check fails; no stale sandbox authority. |
| Job lease lost | Late completion cannot commit; retry from authoritative job state. |
| Duplicate event/webhook/schedule | Same App-visible idempotency identity; no duplicate accepted effect. |
| Storage schema/quota violation | Reject operation; existing records unchanged. |
| UI asset/bridge failure | Slot-local unavailable state; host page remains usable. |
| Disable/quarantine race | New admissions stop; leased/late work follows cancellation and discard policy. |
| Failed update | Active pointer remains or rolls back; no partially visible candidate contributions. |
| Rollback no longer eligible | Refuse rollback and retain current safe state. |
| Removal with dependencies | Show dependencies; require detach/remove decisions; never silently redirect. |

## 25. Deployment Profiles

### Default OSS/self-hosted profile

- App contracts, the `apps`, `appRuntime`, and `appStorage` domains, and the built-in release registry are present.
- The Compose stack registers the local-process provider so the WordPress App works for self-hosters exactly as it does in Radioso Cloud.
- The default application builds and runs with no provider registered, without a sandbox fleet, external artifact registry, or external secret broker; installed Apps then report unavailable.
- The sandbox provider can register through composition without changing App domain rules.

### Radioso Cloud profile

- Registers artifact, admission/revocation, sandbox, runtime network, secret/egress, storage, job dispatch/consumer, UI asset, and telemetry providers.
- Scales runtime instances independently from API and document workers.
- Maintains explicit readiness: an unavailable App runtime degrades App features but does not make core API/chat/document readiness dishonest.

## 26. Validation Strategy

Planning must turn these into failing tests before backend implementation:

- Pure manifest, compatibility, permission-diff, storage-schema, and lifecycle state-machine tests.
- Repository and fault-injection integration tests against disposable PostgreSQL.
- Composition tests proving disabled/default and registered hosted providers.
- Runtime contract tests with malicious, slow, invalid, oversized, cancelled, and unavailable fixtures.
- Cross-workspace identity, storage, secret, networking, UI, and job-isolation tests.
- App-job lease, retry, dead-letter, duplicate, cancellation, and queue-envelope contract tests.
- OpenAPI/SDK drift tests and MCP impact checks.
- Playwright installation, permission review, testing, health, UI slot, update, rollback, quarantine, and removal journeys.
- Performance tests with recorded environment, warm/cold classification, load shape, sample size, clock boundaries, and fleet-pressure cases.
- Conformance personas proving no App-ID branches in generic modules.

## 27. Planning Decisions Still Open

These choices do not change the App abstraction and may be settled during technical planning:

- Concrete sandbox provider and isolation technology.
- Artifact registry and UI asset storage provider.
- Whether the first App worker uses an existing broker transport adapter or database polling plus a later broker.
- Exact per-class default/hard resource ceilings after benchmarks.
- Physical generic App Storage adapter and bounded index representation.
- Cold-start retention and prewarming policy.
- Location of cloud-only provider implementations within the OSS/EE/deployment package boundaries.
- Packaging of the local-process provider: one Compose service hosting per-installation child processes versus one container per installation.
- Length of the legacy WordPress webhook path's deprecation period.

These choices must remain behind the ports above. None may leak provider vocabulary into App manifests or owning product domains.
