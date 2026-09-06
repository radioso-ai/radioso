# Feature Specification: Radioso Hosted App Runtime

**Feature Branch**: `conversational-agent-plugins`  
**Created**: 2026-09-06  
**Status**: Draft  
**Input**: User description: "Define the right App-level abstraction for extending Radioso, including a Radioso Cloud-hosted runtime, typed runtime contributions, safe App storage, optional Agent Packs, and enough breadth to support WordPress/WooCommerce, Magento, Notion, and a CSAT widget without app-specific core changes."

## Context

Radioso already supports operator-authored skills, external MCP tools, versioned routines, portable agent bundles, connector plugins, application composition modules, OAuth connections, webhooks, audit events, and activity traces. These are useful extension mechanisms, but they do not form one installable application model.

An **App** is the primary extension and lifecycle unit. An App can contribute several typed capabilities to a workspace. A **Contribution** is one declared extension point, such as a tool, data source, event subscriber, scheduled task, context provider, or sandboxed UI surface. A **Connection** binds an App installation to external credentials or services. A **Pack** is optional declarative agent configuration—skills, routines, directives, or eval fixtures—distributed by an App; it is not the runtime or trust boundary.

Radioso Cloud will initially host approved App releases. Each workspace installation receives an isolated, scale-to-zero runtime. App code interacts with Radioso and external services only through declared, permissioned contracts. Workspace-installed Apps do not run migrations, declare SQL tables, mount host routes, import frontend components, or receive general database or API access.

WordPress/WooCommerce and CSAT are reference conformance cases because together they exercise data ingestion, live tools, external webhooks, schedules, settings, UI contributions, events, and managed state. This feature does not ship those products.

**One architecture.** Every App, including Apps Radioso authors itself, uses the same manifest, App Gateway, runtime protocol, host capabilities, installation identity, and Managed App Storage. There is no first-party in-process path and no "built-in App" trust shortcut. Where an App process runs is decided by a runtime provider behind one port: a local-process provider ships first and serves development and self-hosted deployments; the Radioso Cloud sandbox provider implements the same port later. Release admission, egress, and sandbox hardening tighten inside their ports over time; they never open a second code path.

This is a **program specification** for a new platform boundary delivered through independently gated releases. Release A ships the WordPress App as the reference App over the full protocol: publication from a built-in registry, installation, connection binding, document-source ingestion, external webhook admission, scheduled polling, durable App Jobs, Managed App Storage, isolation, disable, and removal end to end, and retires the in-process WordPress connector. Later releases add interactive tools and conformance breadth, context and UI, optional Packs, and the Radioso Cloud sandbox provider without reopening the App identity, grant, gateway, or protocol contracts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Install and activate a hosted App safely (Priority: P1)

A workspace administrator installs an approved App release, reviews its identity, compatibility, permissions, external destinations, data-egress declarations, storage requirements, and agent-visible contributions, supplies the required connections, tests the installation, and activates it without changing or redeploying Radioso core.

**Why this priority**: Installation is the customer-facing unit of extensibility. Without a safe and understandable install path, the runtime and contribution contracts have no usable product surface.

**Independent Test**: Install a signed reference App into one workspace, bind its declared connection, run its conformance test with side effects suppressed, activate it, and confirm that only its approved contributions become available to the selected agent and UI slots.

**Acceptance Scenarios**:

1. **Given** a compatible signed App release from an approved source, **When** an authorized administrator reviews and approves the installation plan, completes required bindings, passes the safe test, and activates it, **Then** all approved contributions become available together and the installation reports healthy.
2. **Given** an App requests a permission, egress field, destination, storage collection, or contribution the administrator has not approved, **When** activation is attempted, **Then** activation is rejected without making any contribution available.
3. **Given** an App release is incompatible, unsigned, revoked, malformed, or fails conformance checks, **When** an administrator attempts installation, **Then** Radioso refuses it with actionable diagnostics and no runtime is provisioned.
4. **Given** two workspaces install the same App release, **When** either installation runs or changes state, **Then** its runtime identity, connections, storage, quotas, logs, and contributions remain isolated from the other workspace.

---

### User Story 2 - Publish an immutable hosted App release (Priority: P1)

An approved App developer publishes a versioned release containing a signed App manifest, an immutable executable artifact, declared contributions, optional sandboxed UI assets, compatibility information, resource requirements, storage schemas, security provenance, and conformance fixtures. Radioso validates the release before it can be installed.

**Why this priority**: Hosted execution is safe only when the executable artifact and the contract operators approve are immutable, attributable, and tested as one release.

**Independent Test**: Submit a reference release, verify its manifest and artifact identity, exercise every declared handler against the conformance suite, and confirm that changing any artifact, UI asset, permission, schema, or declaration produces a distinct release requiring validation.

**Acceptance Scenarios**:

1. **Given** an approved publisher and complete release, **When** the release passes signature, provenance, compatibility, vulnerability-policy, schema, and conformance validation, **Then** it becomes eligible for installation under its immutable version and digest.
2. **Given** a release whose executable artifact does not implement a declared contribution, **When** conformance validation runs, **Then** publication fails and the release cannot be installed.
3. **Given** an existing published release, **When** any signed content changes, **Then** it cannot replace the existing artifact under the same immutable release identity.

---

### User Story 3 - Invoke App contributions during agent operation (Priority: P1)

An agent or Radioso runtime invokes a declared App contribution through a common gateway. Radioso authenticates the installation, enforces the approved permission and data contract, applies the contribution's deadline and resource budget, validates the response, and records a safe trace. App failure degrades only the affected contribution and installation.

**Why this priority**: This is the runtime value of the platform and the boundary that protects conversations from third-party failures or authority expansion.

**Independent Test**: Invoke reference tool and context contributions in healthy, timeout, invalid-response, denied, rate-limited, cancelled, and unavailable states and verify typed results, isolation, budget enforcement, and safe degradation.

**Acceptance Scenarios**:

1. **Given** an active installation with an approved tool contribution, **When** an agent invokes that tool with valid declared input, **Then** only that input reaches the installation runtime and the schema-valid result returns within the declared deadline.
2. **Given** an App times out, crashes, exceeds its budget, returns invalid data, or becomes unhealthy, **When** a contribution is invoked, **Then** Radioso returns a typed unavailable or failed outcome, records the reason safely, and does not wedge the conversation or affect another installation.
3. **Given** an installation is disabled, quarantined, revoked, or no longer attached to the agent, **When** a runtime attempts to invoke its contribution, **Then** no App execution starts.
4. **Given** an App tries to invoke an undeclared host capability or reach an undeclared external destination, **When** the request is evaluated, **Then** it is denied and audited without exposing secrets or customer content.

---

### User Story 4 - Run durable event, webhook, and scheduled work (Priority: P1)

An App subscribes to approved committed events, receives approved external webhooks through Radioso's App gateway, and runs declared scheduled tasks. These executions are durable, idempotent, bounded, retryable, and independent of synchronous conversation transactions.

**Why this priority**: The WordPress reference App is driven by external webhook pushes and a scheduled poll, so webhook admission, schedules, and durable App Jobs are required by Release A. Asynchronous Apps must not create a second ungoverned worker system or block core transactions. Committed-event subscriptions are the only part of this story that Release A may defer.

**Independent Test**: Deliver a reference committed event, duplicate external webhook, and scheduled task through success, retry, cancellation, and dead-letter paths while verifying idempotency and installation isolation.

**Acceptance Scenarios**:

1. **Given** an active installation subscribed to an event, **When** that event commits, **Then** one durable delivery is created with only the approved payload projection and retries do not duplicate the App-visible effect.
2. **Given** a signed external webhook for an App installation, **When** Radioso accepts it, **Then** the public request is acknowledged according to policy and App work proceeds asynchronously under the installation's identity and limits.
3. **Given** a scheduled task whose prior run is still active, **When** its next schedule arrives, **Then** Radioso applies the contribution's declared overlap policy rather than starting uncontrolled duplicate work.
4. **Given** an installation is disabled or quarantined, **When** queued or scheduled work becomes eligible, **Then** it is skipped or cancelled according to the recorded lifecycle policy and cannot regain authority by retrying.

---

### User Story 5 - Store App data without App-defined tables (Priority: P1)

An App stores lightweight installation data in declared, versioned, namespaced collections through managed App Storage, or explicitly declares that domain data leaves Radioso for an approved external service. The App never receives SQL access or declares host database migrations.

**Why this priority**: The WordPress reference App keeps its sync cursor, backfill progress, and external-ID mapping in Managed App Storage, because under one architecture it has no access to the connector sync-state table. Useful Apps need state, but arbitrary tables and migrations would couple Radioso's system of record, upgrades, backups, and availability to extension code.

**Independent Test**: Create, read, update, query, expire, export, and delete records in a reference collection; attempt cross-installation access, undeclared fields, undeclared indexes, quota overflow, and destructive schema change; verify safe enforcement.

**Acceptance Scenarios**:

1. **Given** a declared collection and active installation, **When** the App writes a schema-valid record within quota, **Then** it is stored under that installation and visible only through its scoped storage authority.
2. **Given** an App attempts SQL access, cross-App access, cross-workspace access, an undeclared collection, invalid data, or an unsupported query, **When** storage evaluates the operation, **Then** it is rejected without affecting other records.
3. **Given** an App release adds only backward-compatible collection fields, **When** the release is validated, **Then** existing records remain readable without arbitrary migration code.
4. **Given** an App needs complex relational or high-volume domain storage, **When** it declares an approved external data destination, **Then** the installation preview distinguishes that external storage from Radioso-managed storage and shows the applicable egress.

---

### User Story 6 - Render a sandboxed App UI contribution (Priority: P4)

An App contributes UI to a finite set of semantic slots. Radioso renders immutable App assets in an isolated frame, gives the frame a short-lived slot-specific session, and exposes only declared host commands and bounded context through a versioned bridge.

**Why this priority**: Apps such as CSAT need user and operator surfaces, but imported frontend components would couple third-party code to Radioso internals and allow unsafe dashboard access.

**Independent Test**: Render a CSAT fixture after an assistant message and an operator summary view, submit feedback through a scoped command, and verify that the frame cannot read unrelated conversation data, workspace credentials, cookies, parent DOM, or undeclared host APIs.

**Acceptance Scenarios**:

1. **Given** an active UI contribution approved for a supported slot, **When** the relevant Radioso surface renders, **Then** the contribution receives only the context and commands declared for that slot.
2. **Given** a UI asset fails, times out, violates policy, or sends an invalid bridge message, **When** Radioso handles it, **Then** the failure remains inside the App boundary and the core page stays usable.
3. **Given** an App update changes its UI permissions, origins, commands, or data access, **When** the update is reviewed, **Then** the change requires explicit approval before the new UI becomes active.

---

### User Story 7 - Update, rollback, disable, quarantine, and remove an App (Priority: P1)

A workspace administrator can preview an update, test it beside the active release, activate it without partial visibility, roll back to the previous healthy release, disable all contributions quickly, and remove the App with an explicit data-retention choice. A Radioso operator can quarantine a vulnerable release across installations without deleting customer-owned data.

**Why this priority**: Extension installation is incomplete without safe recovery, revocation, and removal.

**Independent Test**: Upgrade a reference installation through compatible, permission-widening, unhealthy, and rollback cases; then disable, quarantine, detach locally retained data, and uninstall it.

**Acceptance Scenarios**:

1. **Given** a compatible update that does not widen authority, **When** it passes installation-specific tests, **Then** activation makes the new contribution set visible together and retains the prior release as a rollback checkpoint.
2. **Given** an update adds permissions, egress, destinations, UI context, storage, or contribution types, **When** the administrator has not approved the new authority, **Then** the existing release remains active.
3. **Given** the new release fails health or runtime checks after activation, **When** rollback is requested or automatic rollback policy triggers, **Then** the previous release resumes without restoring revoked credentials or permissions.
4. **Given** an administrator removes an App, **When** removal runs, **Then** runtime authority is revoked before the operator chooses to export, retain temporarily, or delete managed App data.
5. **Given** Radioso quarantines a release, **When** an affected installation attempts execution, **Then** no new invocation starts and operators receive a safe actionable status without customer data being deleted.

---

### User Story 8 - Distribute optional Agent Packs with an App (Priority: P5)

An App release may include declarative Packs that configure selected agents using existing Radioso skills, routines, directives, and eval fixtures. Installing an App does not silently install or activate a Pack; the operator separately previews, targets, tests, and activates it.

**Why this priority**: Packs turn runtime capability into useful agent behavior while preserving the distinction between application authority and operator-owned configuration.

**Independent Test**: Install a reference App, then install its optional Pack into one agent, bind Pack skills to App contributions, test it safely, activate it, and remove the Pack without uninstalling the App or deleting its connection.

**Acceptance Scenarios**:

1. **Given** an installed App provides an optional compatible Pack, **When** an administrator installs it into an agent, **Then** Pack-owned behavior is reviewed and lifecycle-managed separately from the App installation.
2. **Given** a Pack requires an unavailable or unhealthy App contribution, **When** installation or activation is attempted, **Then** the Pack remains inactive with an actionable unresolved requirement.
3. **Given** a Pack is removed, **When** the underlying App remains installed, **Then** other agents and contributions using the App continue to work.

### Edge Cases

- A manifest is valid but its executable artifact, UI assets, schema fingerprint, or content digest does not match the signed release.
- A publisher key is revoked while the registry is unavailable or while installations are active.
- A release becomes vulnerable after installation; quarantine must stop execution without deleting data.
- Installation is interrupted after sandbox provisioning, connection creation, storage initialization, or contribution staging.
- Activation races with disable, uninstall, update, quarantine, permission revocation, agent deletion, or workspace deletion.
- An App release declares duplicate contribution IDs, unsupported contribution kinds, cyclic Pack dependencies, or conflicting UI slots.
- An App attempts to disguise credentials or personal data as a public fixed value or undeclared tool input.
- DNS changes, redirects, or rebinding cause an approved hostname to resolve to a prohibited network destination.
- A context provider misses its deadline; the turn must continue or fail according to the declared requirement without fabricated context.
- An interactive tool returns after cancellation or after its installation was disabled.
- An event is delivered more than once, out of order, or after its payload contract has advanced.
- An external webhook is duplicated, replayed, forged, oversized, or addressed to a removed installation.
- A scheduled task overlaps, runs longer than its lease, exhausts quota, or becomes eligible during an update.
- A sandbox cold start, crash loop, noisy neighbor, or resource limit affects one installation but not others.
- Managed storage reaches record, byte, query, or index limits; writes fail predictably without corrupting existing records.
- A collection schema change would make existing records invalid or requires a destructive migration.
- An App uses external storage in another region or changes its declared data destination.
- A UI contribution is blocked by content security policy, is unavailable, sends malformed messages, or tries to escape its frame.
- App-authored content is extremely long, maliciously nested, or intended to enter prompts or logs.
- An App or Pack is removed while another Pack, routine, directive, or agent still depends on one of its contributions.
- Rollback targets an artifact that has since been revoked or is no longer compatible with the current Radioso version.
- A workspace with an enabled in-process WordPress connector is migrated while the PHP companion plugin is still pushing to the legacy webhook URL; no push may be lost or double-ingested.
- A migrated installation's legacy webhook secret, application password, or polling interval is missing or invalid; the installation must surface an unresolved requirement rather than silently disable sync.
- The runtime provider is absent in a deployment profile; installed Apps report unavailable, the Documents menu still offers the App, and the core product is unaffected.

## Non-Goals

- Public marketplace search, ratings, billing, revenue sharing, or unrestricted publisher self-service.
- Building WordPress, WooCommerce, Magento, Notion, or CSAT as shipped integrations in this feature.
- Building arbitrary source code submitted by publishers inside Radioso Cloud.
- Accepting mutable tags or arbitrary public executable images; hosted releases come from approved sources and are pinned immutably.
- Running multiple workspaces inside one App sandbox in the initial runtime.
- Allowing App-defined SQL tables, migrations, direct database connections, arbitrary filesystem access, host route mounting, or general Radioso API tokens.
- Loading App backend code into the Radioso API or worker processes.
- Loading App frontend components into the Radioso frontend bundle or granting UI frames access to dashboard cookies or DOM.
- Exposing generic before-turn or after-answer hooks that can inspect or rewrite all conversation behavior.
- Replacing assistant, retrieval, SDK, MCP, connector, or routine contracts with one generic execute endpoint.
- Supporting arbitrary long-running daemons, unrestricted network listeners, or unbounded background work.
- Supporting third-party channel adapters in the first hosted runtime; identity and delivery channels require a separate higher-authority specification.
- Automatic installation of optional Packs or silent overwriting of operator-authored agent behavior.
- A first-party or "built-in" App path that bypasses the manifest, App Gateway, runtime protocol, host capabilities, or Managed App Storage. Radioso-authored Apps are ordinary Workspace Apps.
- Adding new document-source connectors to the deployment-trusted `ConnectorPlugin` contract; that contract remains for channel connectors only.

## Delivery Program And Release Gates

Each release is deployable behind a disabled-by-default capability and has its own end-to-end fixture, acceptance evidence, rollback path, and documentation. A later release may depend on the stable contracts delivered by an earlier release, but it MUST NOT be required to demonstrate the earlier release's user value.

### Release A — WordPress reference App over the full protocol

- Ship the provider-neutral contract package: manifest, contribution discriminated union, invocation envelopes, App Job wake-up envelope, storage declarations and scoped operations.
- Ship the `apps` domain: releases admitted from a Radioso-owned built-in registry behind the release-admission port, installations, deterministic plans, grants, connections, lifecycle saga, disable, and removal. Signature and provenance verification run against the built-in registry's keys; external publisher admission is not opened.
- Ship the App Gateway with per-invocation installation identity and the host capabilities the WordPress App needs: document ingest and delete, Managed App Storage, and mediated egress fetch with declared-destination and prohibited-network enforcement.
- Ship the runtime provider port with the local-process reference provider (one App process per installation, started and stopped by the provider, packaged as a Compose service for development and self-hosted deployments).
- Ship document-source, external-webhook-handler, and scheduled-task contributions, the durable App Job contract with compare-and-set leasing, retry, and dead-letter, and Managed App Storage collections with schema validation, quotas, and optimistic versions.
- Ship the WordPress App as an out-of-process App: connection (site URL, application password, webhook secret), document source with stable external IDs and indexed fields, webhook handler for the PHP companion plugin, scheduled poll and backfill, cursor and mapping collection, manifest-declared setup guide and companion download.
- Migrate existing WordPress connector configurations into App installations, connections, and storage records; keep the legacy webhook URL answering by forwarding to the installation-scoped gateway endpoint; retire the in-process WordPress connector and every WordPress-specific dashboard branch.
- Deliver the generic Apps dashboard: catalog, release inspection, plan review, configuration form rendered from the schema, connection binding, safe test, health, disable, removal, and the Documents-menu entry that lists installed document-source Apps.
- Ship no interactive tool, context, UI-slot, event-subscription, or Pack runtime behavior.

**Gate**: User Stories 1, 2, 4 (webhook and schedule scenarios), 5, and the disable/removal scenarios of User Story 7 pass; the WordPress App reaches parity with the retired connector (push, poll, backfill, delete, indexed fields) with zero WordPress-specific branches in core modules or the frontend; the default build passes with no runtime provider configured.

### Release B — Interactive tools and conformance breadth

- Add the interactive tool contribution and its projection through the per-agent named-skill model, and the context execution class budgets.
- Add the WordPress App's first live tool (order or product lookup through mediated egress) and the Magento- and Notion-shaped conformance fixtures without vendor-specific core behavior.
- Add committed-event subscriptions and the public App-event catalog.

**Gate**: User Story 3, the event scenarios of User Story 4, and the three source/integration conformance maps pass while Release A remains independently operable.

### Release C — Context and sandboxed UI

- Add bounded context-provider contributions, semantic UI slots, immutable UI assets, scoped UI sessions, and UI commands.
- Prove the CSAT conformance fixture over Managed App Storage.

**Gate**: User Story 6 and the context/UI portions of User Story 3 pass without requiring Packs.

### Release D — Packs, updates, and recovery completion

- Add optional Pack distribution and its separate installation lifecycle.
- Complete candidate-release update testing, re-approval, rollback, release quarantine, dependency-aware removal, and managed-data disposition across all contribution types.

**Gate**: User Stories 7–8 pass against artifacts produced by prior releases.

### Release E — Radioso Cloud sandbox provider and admission hardening

- Implement the sandbox runtime provider (immutable root, bounded scratch, restricted syscalls, scale-to-zero, per-installation quotas) behind the existing runtime provider port.
- Tighten release admission to external approved publishers: signature, provenance, software inventory, vulnerability policy, and revocation propagation.
- Add short-lived credential exchange in the egress broker and DNS/redirect re-validation at connect time where not already enforced.

**Gate**: The WordPress App and every conformance fixture run unchanged on the sandbox provider; isolation, noisy-neighbor, and cold-start measurements meet SC-003 through SC-006. Public marketplace discovery, billing, and unrestricted publisher admission remain out of scope.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is explicitly approved.
- Backend development MUST follow TDD: tests are written and observed failing before implementation.
- Backend services MUST use the repository's Node.js stack; frontend surfaces MUST use React and existing UI primitives.
- PostgreSQL remains Radioso's system of record; Apps never receive direct database authority.
- New configuration and signing material MUST follow repository secret-management rules and update applicable example environment and deployment documentation.
- Customer data MUST be minimized, permissioned, region-aware, securely transmitted, and represented in clear operator approvals and audit trails.
- Admin-facing pages MUST use existing design tokens and interaction conventions.
- User-visible conversational responses remain LLM-authored and multilingual; App runtime infrastructure MUST NOT hard-code assistant replies.
- Runtime prompt assets, if later required, MUST live under `backend/prompts/`; this feature SHOULD NOT require new model-facing prompts for core App execution.
- Public route and payload changes MUST be registered in the code-first OpenAPI source and regenerate backend and TypeScript SDK snapshots in the same change.
- Contract changes MUST include explicit review of App job delivery, document-worker dispatch, AMQP payloads, retry semantics, and queue documentation/tests.
- Operator-facing features MUST ship Ray tool coverage or an explicit coverage-map exclusion.
- Product and public contract changes MUST update operator, App-author, SDK, runtime, storage, and security documentation in the same change.

## Architecture Constraints *(mandatory)*

- **App Domain Ownership**: A focused App domain owns App identity, immutable releases, installations, grants, connections, attachments, contribution declarations, lifecycle state, update/rollback policy, and managed-data disposition. It MUST NOT own provider protocols, container scheduling, chat behavior, document ingestion behavior, routine semantics, or UI rendering.
- **Runtime Orchestration Ownership**: A focused hosted-runtime module owns provisioning, scale-to-zero lifecycle, invocation admission, deadlines, cancellation, resource budgets, health, and isolation. It consumes a sandbox/runtime provider port and MUST NOT encode App product rules or contribution-specific behavior.
- **Gateway Ownership**: The App Gateway owns private invocation transport, public App webhook admission, short-lived installation identities, request/response envelope validation, egress mediation, and correlation. It MUST NOT own agent routing, routine selection, storage policy, or provider-specific product logic.
- **Contribution Ownership**: Each Radioso product module owns the narrow port through which an App contributes to that domain. Documents own App ingestion admission; skills own App tool projection; chat/context owns bounded context intake; events own safe post-commit projections; frontend owns semantic UI slots. These modules MUST NOT import an App runtime implementation.
- **Storage Ownership**: App Storage owns namespaced collections, schema validation, quotas, concurrency, query limits, expiry, export, retention, and deletion. Apps declare logical collections, never physical tables or migrations.
- **Pack Ownership**: Agent Pack portability and installation remain a declarative configuration concern separate from App runtime installation. Packs may reference stable App contribution identities but MUST NOT acquire runtime authority independently.
- **Composition Boundary**: `backend/src/app/composition/` assembles App repositories, domain services, gateways, runtime providers, storage adapters, contribution adapters, workers, sinks, and optional deployment implementations. Composition MUST NOT contain installation, authorization, reconciliation, or product rules.
- **Existing Runtime Boundaries**: The conversation engine, routine engine, assistant routes, retrieval APIs, standalone MCP server, and document worker MUST remain App-protocol-agnostic. They consume existing or newly focused product ports, never App manifests or sandbox clients directly.
- **Agent Runtime Anti-Goal**: The hosted App runtime MUST NOT extend or reuse `backend/src/shared/agent-runtime/` as its process, job, persistence, or installation substrate. The shared Agent Runtime remains a stateless per-call tool-calling LLM loop; hosted Apps receive no implicit model, agent, prompt, or conversation authority.
- **Trusted Module Boundary**: Existing `ApplicationModule` and `ConnectorPlugin` mechanisms remain deployment-trusted paths for infrastructure and channel connectors. A workspace-installed App MUST NOT inherit their database, migration, route, or process authority, and they MUST NOT be used to implement Apps.
- **First-Party App Boundary**: Apps that Radioso authors, starting with WordPress, are ordinary Workspace Apps. They MUST be implemented over the manifest, App Gateway, runtime protocol, host capabilities, and Managed App Storage, run under the runtime provider, and MUST NOT import backend modules, use the connector ingestion port, read connector tables, or mount routes. The in-process WordPress connector and its frontend branches are retired by Release A.
- **Runtime Provider Boundary**: Exactly one runtime protocol exists. Where an App process runs is chosen by a runtime provider behind one port; the local-process provider and the Radioso Cloud sandbox provider are two implementations of that port. App code, manifests, and product domains MUST NOT observe which provider is active. Hardening of admission, egress, and sandboxing happens inside those ports and MUST NOT introduce a second execution path.
- **New Seams Required**: Planning MUST define focused contracts for manifest validation, release admission, installation planning, lifecycle saga/recovery, activation visibility, installation identity issuance, contribution registration, runtime invocation, sandbox provisioning, egress mediation, managed storage, event delivery, webhook admission, scheduled execution, UI bridge sessions, release quarantine, and safe telemetry.
- **Failure Boundary**: App failures, budgets, health state, queues, and circuit breakers MUST be installation-scoped. No App failure may wedge a core conversation, block the transaction that produced an event, or affect another workspace's runtime.
- **Data Boundary**: Raw prompts, completions, document content, retrieved chunks, conversation bodies, credentials, tokens, cookies, connection strings, and App payloads MUST NOT enter logs, metrics, package metadata, or unsigned diagnostics.
- **Message-Queue Boundary**: App events, schedules, external webhooks, and asynchronous invocations use a distinct versioned App-job contract and PostgreSQL system of record owned by the App runtime area. A dispatcher MAY publish only a versioned wake-up envelope containing an App job ID through a separately named queue or topic. Document-processing job rows and payloads MUST NOT carry App work. Existing AMQP infrastructure MAY supply transport after an explicit adapter and queue-isolation review; App retries, leases, cancellation, and dead letters remain authoritative in App-job persistence.

## Requirements *(mandatory)*

### Functional Requirements — App vocabulary and releases

- **FR-001**: The system MUST define **App**, **App Release**, **App Installation**, **Contribution**, **Connection**, **App Storage Collection**, and **Agent Pack** as distinct product concepts with stable identities and lifecycle ownership.
- **FR-002**: An App Release MUST be immutable and identify its App, semantic version, manifest schema version, compatible Radioso versions, publisher, executable artifact digest, optional UI asset digest, permissions, contributions, resource profile, external destinations, storage declarations, conformance fixtures, and security provenance.
- **FR-003**: The system MUST verify the release signature and every referenced immutable digest before publication, installation, update, or rollback.
- **FR-004**: The initial release-admission policy MUST accept only approved publishers and executable artifacts from approved registries pinned by digest; mutable tags and publisher-submitted source builds MUST be rejected.
- **FR-005**: Release admission MUST validate provenance, software inventory, vulnerability policy, manifest shape, compatibility, contribution schemas, resource bounds, egress declarations, storage declarations, UI policy, and handler conformance before marking a release installable.
- **FR-006**: App and contribution identifiers MUST be globally stable within their declared scope and MUST NOT silently change meaning between compatible releases.
- **FR-007**: Unknown manifest versions, contribution kinds, permissions, storage features, execution classes, or security declarations MUST be rejected rather than ignored.
- **FR-008**: A published release MUST NOT be mutated in place; any change to executable code, UI assets, manifest, permissions, contributions, egress, or storage creates a new immutable release.

### Functional Requirements — Contribution model

- **FR-009**: The App Spec MUST represent contributions as a closed, versioned discriminated catalog rather than arbitrary named hooks.
- **FR-010**: The initial catalog MUST support tool, context-provider, document-source, event-subscription, external-webhook-handler, scheduled-task, sandboxed-UI, and optional Agent-Pack contributions. App configuration is manifest metadata shared by contributions, not an executable contribution kind.
- **FR-011**: Every contribution MUST declare a stable contribution ID, purpose, execution class, typed input and output contracts where applicable, required permissions, data-egress fields, resource/deadline bounds, failure semantics, and availability requirements.
- **FR-012**: Contributions MUST address semantic product extension points; Apps MUST NOT reference internal routes, database tables, frontend components, CSS selectors, worker payloads, or implementation classes.
- **FR-013**: Tool contributions MUST project into the existing named-skill and executor model so routines and supported agent selection paths use them without learning the hosted runtime protocol.
- **FR-013a**: Attaching an App tool to an agent MUST create or bind a normal entry on the unified `agent_skills` spine through the skills module. The skill MUST retain the existing per-agent name uniqueness rule, explicit invocation mode, enabled state, typed bound/exposed inputs, stable structured outcomes, target identity, capability checks, usage references, and safe behavior when its App installation or connection is unavailable.
- **FR-013b**: The App tool capability descriptor MUST be data-driven for generic authoring surfaces and MUST identify the App installation and stable contribution ID as its target. Name collisions, incompatible input bindings, unsupported invocation modes, missing outcomes, and revoked targets MUST be reported before persistence. Pack references MUST use the resulting agent skill's stable name and MUST also retain the originating App/contribution requirement for portability diagnostics.
- **FR-014**: Context-provider contributions MUST declare scope, sensitivity, surfacing policy, cache behavior, deadline, maximum result size, and whether absence is optional or turn-blocking.
- **FR-015**: Document-source contributions MUST ingest and delete content only through the documents module's guarded ingestion contracts and MUST declare stable external identities, source provenance, supported synchronization modes, and indexed-field vocabulary.
- **FR-016**: Event subscriptions MUST choose from a versioned public App-event catalog and MUST receive only the approved projection for each subscribed event.
- **FR-017**: External webhook handlers MUST use installation-specific public endpoints, authenticate and bound incoming requests, reject replays, and move accepted work onto durable execution before App code runs.
- **FR-018**: Scheduled tasks MUST declare schedule bounds, overlap policy, maximum duration, retry policy, and checkpoint behavior; Apps MUST NOT create unbounded or sub-minimum schedules.
- **FR-019**: UI contributions MUST target a versioned catalog of semantic slots and MUST declare the context fields, host commands, origins, asset identity, and presentation bounds required by each slot.
- **FR-020**: Agent Packs MUST remain optional, separately previewed and activated, and incapable of granting permissions beyond the installed App contribution they reference.
- **FR-020a**: Pack installation MUST reuse the portable-agent conflict and reference semantics: contents and references are versioned and secret-free; workspace-bound values become explicit Connection or App-contribution requirements; unresolved requirements are reported rather than dropped; and existing operator-authored elements are not overwritten without an explicit conflict decision.
- **FR-020b**: Pack-created elements MUST retain Pack, App, and release provenance for update, detach, disable, and removal. Removing or making a referenced App contribution incompatible MUST leave the dependent Pack element visibly degraded or inactive; it MUST NOT silently redirect the reference to another capability.
- **FR-021**: Third-party channel contributions are excluded from the initial catalog; encountering one MUST return an unsupported-contribution diagnostic rather than partially installing it.
- **FR-021a**: Every App Release MUST declare one versioned configuration schema owned by the App domain. The schema MAY use the existing bounded field vocabulary for text, number, boolean, selection, URL, and connection-slot references; secret or OAuth values MUST be represented only as write-only Connection fields. The dashboard MUST render the generic schema without App-specific branches, and the App runtime MUST receive only validated non-secret values plus opaque connection handles.
- **FR-021b**: Configuration changes MUST follow the App Installation lifecycle, optimistic-version checks, current-principal authorization, audit, and re-test rules. An App MAY provide a sandboxed App-detail UI for richer workflows, but that UI MUST NOT replace authoritative configuration validation or credential handling.
- **FR-021c**: An App Release MAY declare a setup guide as structured text sections and companion assets (such as a downloadable site plugin) identified by immutable digest. The dashboard MUST render the guide and asset links generically from the manifest; no App-specific setup component, menu entry, or download link may exist in the frontend.

### Functional Requirements — Installation and grants

- **FR-022**: An authorized workspace administrator MUST be able to inspect an App release before mutation and see its publisher, version, compatibility, contributions, requested permissions, external destinations, field-level egress, storage and residency, UI placement, resource profile, and known security status.
- **FR-023**: The system MUST produce a deterministic installation plan identifying every runtime, connection, agent attachment, contribution, UI slot, storage collection, Pack, permission, and unresolved requirement that would be created or changed.
- **FR-024**: Plan approval MUST be bound to the exact release, target workspace and agents, connection bindings, grant set, egress declarations, and current relevant versions; stale or changed plans MUST require new review.
- **FR-025**: Installation MUST collect secrets and OAuth grants through write-only connection flows. Secrets MUST NOT appear in manifests, Packs, plans, logs, traces, managed App records, or frontend-readable state.
- **FR-026**: Installation MUST create an installation-scoped identity and MUST NOT issue a general workspace, account, agent-channel, or internal service credential to the App.
- **FR-027**: Apps MUST receive only explicitly granted host capabilities and contribution data. App identity MUST NOT substitute for the installing administrator's authority during installation or later privileged changes.
- **FR-027a**: Every protected App read and effect MUST re-evaluate the current human, service-account, or Ray principal's workspace membership and operation-specific permission at execution time. This includes plan inspection and approval, release publication, connection binding, attachment changes, testing with live effects, Pack activation, update, rollback, disable, quarantine override where permitted, export, retention, deletion, and resumed lifecycle steps.
- **FR-027b**: A durable operation MAY resume system-owned compensating or safety work after the initiating principal loses access, but MUST NOT resume or add a new privileged effect on that principal's former authority. Operations paused before an uncommitted protected effect require a currently authorized principal to approve a new plan.
- **FR-028**: Installation MUST stage and test contributions before activation; staged contributions MUST be invisible to live conversations, schedules, public webhooks, events, and UI slots.
- **FR-029**: Activation MUST make one tested release's approved contribution set visible atomically from the runtime's perspective. Partial contribution activation is prohibited.
- **FR-030**: Install, update, rollback, disable, quarantine, removal, and data-disposition operations MUST be durable, idempotent, resumable after process interruption, and auditable.
- **FR-030a**: Ray App tools MUST declare the same public operation or owning-module primitive, permission, confirmation requirement, and target scope as the direct dashboard/API action. Catalog construction MUST validate descriptor provenance and forward/reverse coverage; operations intentionally withheld from Ray MUST be recorded in the maintained coverage map with a reason. Ray proposals grant no App or operator authority and application MUST recheck the current operator principal.
- **FR-031**: Apps MUST attach explicitly to a workspace and, where required, selected agents or UI surfaces. Installation alone MUST NOT silently make an App available to every agent.

### Functional Requirements — Radioso-hosted runtime

- **FR-032**: Radioso Cloud MUST be able to provision each App Installation into an execution sandbox that never contains another workspace's App installation data or credentials.
- **FR-032a**: Provisioning MUST go through one runtime provider port. The reference local-process provider MUST run one App process per installation, start and stop it on demand, pass only the installation identity and gateway address, and expose the same health, drain, and invocation semantics as the sandbox provider. A deployment with no provider registered MUST report installed Apps as unavailable rather than fail to start.
- **FR-033**: An installation sandbox MUST support reuse between invocations for that installation and scale to zero when idle without treating local memory or filesystem contents as durable state.
- **FR-034**: The sandbox MUST have an immutable executable filesystem, bounded temporary storage, bounded CPU and memory, restricted system calls, no host/container-control access, no cloud metadata access, no direct Radioso database or internal-network access, and no undeclared public listener.
- **FR-035**: All Radioso-to-App invocations MUST pass through one private App Gateway that authenticates the installation and contribution, validates the request and response envelopes, applies deadlines and cancellation, and correlates safe diagnostics.
- **FR-036**: Each invocation MUST use a short-lived identity limited to the installation, contribution, approved host capabilities, invocation, and expiry. Reuse for another contribution, workspace, or expired invocation MUST fail.
- **FR-037**: The initial execution classes MUST include interactive tool, context, asynchronous event, scheduled task, external webhook, and UI-command execution, each with distinct deadline, retry, overlap, and side-effect rules.
- **FR-038**: Interactive and context executions MUST NOT become detached background jobs. Event, scheduled, and webhook executions MUST NOT block the core transaction or conversation that caused them.
- **FR-039**: Runtime input and output MUST be validated against the installed release's contracts before crossing the gateway. Invalid responses MUST become typed contribution failures and MUST NOT reach product domains as trusted data.
- **FR-040**: The runtime MUST enforce per-installation and per-contribution request rate, concurrency, execution time, response size, temporary storage, and aggregate resource budgets.
- **FR-040a**: Admission MUST also enforce bounded capacity at request-source, workspace/account, publisher/release, sandbox-fleet, public-webhook, App-job queue/worker, UI-session/command, and storage-query scopes. Exhaustion MUST fail synchronous work quickly with a typed unavailable result, keep asynchronous retry and queue growth bounded, and prevent one installation from consuming another installation's reserved admission budget.
- **FR-041**: Cancellation, disable, quarantine, permission revocation, or workspace deletion MUST prevent further work and MUST stop or safely discard late results according to the execution class.
- **FR-042**: Repeated runtime failures MUST open an installation-scoped circuit and surface a degraded state; recovery MUST require successful bounded health checks or operator action according to policy.
- **FR-043**: Runtime tests MUST suppress external side effects by default and record proposed calls. A live test call MUST require explicit approval of its destination and input class for that run.
- **FR-043a**: Every asynchronous App execution MUST have one durable App Job record containing contract version, job ID, workspace, installation, release, contribution, execution class, source-event or schedule version, input-projection reference, idempotency key, creation and availability time, deadline, attempt ceiling, lease state, cancellation state, and safe terminal outcome. Raw secrets and unrestricted customer payloads MUST NOT be placed in queue wake-up envelopes.
- **FR-043b**: A versioned App-job wake-up envelope MUST contain only the job ID and envelope version. Consumers MUST reload current job, installation, grant, contribution, release, cancellation, and quarantine state from the system of record before acquiring a lease or invoking App code.
- **FR-043c**: App Jobs MUST use compare-and-set leasing with bounded lease expiry, heartbeat/extension limits, exponential backoff with jitter, per-class maximum attempts, explicit retryable and terminal outcomes, and a dead-letter state visible to operators. Acknowledgement occurs only after the handler result and any accepted host-side effects are durably recorded.
- **FR-043h**: Every retry of one logical App Job MUST deliver the same App-visible idempotency key to the handler and to host capability calls. Radioso-managed effects MUST deduplicate on that key where the owning capability declares deduplication support. Arbitrary third-party effects remain at-least-once unless the provider supports an idempotency contract; the App manifest and operator diagnostics MUST disclose that behavior, and Apps MUST checkpoint only after the corresponding effect is known durable.
- **FR-043d**: The originating event publisher MUST durably hand off a versioned public App event only after the source mutation commits and MUST preserve a stable source-event ID. Subscription fan-out MUST derive installation-specific jobs idempotently from that identity. App events MUST NOT block or roll back the source mutation.
- **FR-043e**: External webhook admission MUST authenticate, size-bound, replay-check, and durably persist an installation/contribution-addressed job before acknowledging accepted asynchronous work. Duplicate webhook identities MUST resolve to the same App-visible idempotency key.
- **FR-043f**: Schedule admission MUST persist the logical scheduled occurrence, apply the declared skip/queue/replace overlap policy, and create at most one job for the same installation, contribution, and occurrence. Disable, removal, quarantine, or grant revocation MUST prevent unleased work from starting and MUST cause late results to be discarded safely.
- **FR-043g**: App-job payload and event-schema compatibility MUST be explicit. A worker MUST reject an unsupported contract version safely; active, candidate, queued, and rollback releases MUST declare which input/event/storage schema versions they can consume before activation.

### Functional Requirements — Networking, connections, and secrets

- **FR-044**: App network egress MUST be denied by default and mediated through a policy-enforcing host capability that validates declared destinations before every connection, including redirects and current address resolution.
- **FR-045**: An App Release MUST declare external destination patterns, protocols, ports, purpose, data classes, and applicable connection slots. Installation and updates MUST display them for approval.
- **FR-046**: The system MUST prevent access to loopback, link-local, private, metadata, cluster-internal, or otherwise prohibited addresses unless a separately governed deployment policy explicitly permits a narrowly identified destination.
- **FR-047**: Connection secrets MUST remain in Radioso's secret store. Where possible, the egress layer MUST inject or exchange credentials so App code receives short-lived provider authority rather than durable secret material.
- **FR-048**: Every App-to-host operation MUST be checked against the installation's current grants at execution time so disable, revocation, rotation, or quarantine takes effect without waiting for sandbox replacement.
- **FR-049**: Any release update that widens destinations, egress fields, host capabilities, UI context, event payloads, connection scopes, or storage MUST require explicit re-approval before activation.
- **FR-049a**: Release admission MUST use a versioned Radioso-owned policy snapshot recorded with the release decision. The initial policy requires an approved publisher key, valid signature and immutable digests, verified build provenance, a parseable software inventory, no known critical or high-severity vulnerability prohibited by the current policy, compatible manifest/runtime versions, successful conformance fixtures, and destinations permitted by the current network policy.
- **FR-049b**: No workspace administrator or App publisher may bypass release-admission or quarantine policy in the initial releases. A Radioso security operator MAY publish a new global policy version, revoke a publisher key or artifact, or quarantine a release; every such action and reason MUST be audited.
- **FR-049c**: New install, update, and rollback admission MUST fail closed when current signature, policy, or revocation status cannot be established. Already-active installations MAY continue under their last valid admission decision while the registry is unavailable, but an explicit revocation or quarantine MUST propagate to execution admission within five minutes.
- **FR-049d**: Network admission MUST use the release's recorded destination declarations plus the current Radioso-owned prohibited-network policy. DNS resolution, redirects, connection targets, and current grants MUST be checked at call time; a manifest declaration alone never permits a destination.
- **FR-049e**: Revoking a release MUST automatically impose the same execution-admission, job-leasing, storage-access, UI-session, schedule, event-delivery, and webhook-dispatch blocks as quarantine. Revocation may additionally make rollback or reactivation permanently ineligible; neither state deletes customer data by itself.

### Functional Requirements — Managed App Storage

- **FR-050**: Apps MUST NOT declare physical tables, indexes, SQL, migrations, database roles, or direct database connections in the workspace-installed App Spec.
- **FR-050a**: Radioso MUST implement managed collections over a replaceable, Radioso-owned generic physical storage model. Installing or updating an App MUST NOT create App-specific physical tables or indexes, and Apps MUST NOT observe or depend on the physical storage representation.
- **FR-051**: An App MAY declare logical namespaced collections with stable IDs, scope, versioned record schema, bounded scalar indexes, retention policy, expiry policy, record and byte limits, and allowed query operations.
- **FR-052**: Managed App Storage MUST isolate records by workspace and App Installation and MUST reject cross-installation access even when collection and record keys match.
- **FR-053**: Storage writes MUST validate collection identity, schema, size, quota, and optimistic version before mutation; storage reads and queries MUST enforce declared fields, indexes, filters, sort, page size, and result limits.
- **FR-054**: The initial storage schema evolution policy MUST allow backward-compatible additions and MUST reject changes requiring arbitrary or destructive migration code. Older installed releases MUST continue to read the schema versions they declare compatible.
- **FR-054a**: Before candidate activation or rollback, the system MUST compute compatibility across the active release, candidate release, eligible rollback releases, existing stored-record versions, and queued App-job input/event versions. Activation or rollback MUST fail before visibility changes when any required reader/writer combination is undeclared or incompatible.
- **FR-055**: Complex relational, high-volume, or externally shared domain data MUST remain App-owned external storage and MUST appear in installation egress and residency disclosures.
- **FR-056**: Disabling or quarantining an App MUST revoke runtime storage access without deleting records. Removal MUST require an explicit choice to export, retain for a bounded period, or delete managed App data.
- **FR-057**: Workspace deletion and retention enforcement MUST include managed App data, secrets, runtime identities, queued work, and UI sessions in the existing customer-data deletion guarantees.

### Functional Requirements — UI isolation

- **FR-058**: Radioso MUST serve App UI as immutable assets associated with the installed release and render them in isolated frames; Apps MUST NOT execute inside the Radioso frontend JavaScript context.
- **FR-058a**: App UI assets MUST be served from a cookie-isolated origin distinct from dashboard and API origins. The frame sandbox and Content Security Policy MUST omit same-origin privilege, top-level navigation, popups, downloads, storage access, and undeclared network destinations by default; dashboard cookies MUST be host-only and MUST NOT accompany App asset or subresource requests. Any narrowly enabled browser capability MUST be declared by the UI slot contract and tested against navigation, origin, subresource, and credential escalation.
- **FR-059**: Each UI frame MUST receive a short-lived session limited to one installation, contribution, slot, visible entity, approved context fields, and host commands.
- **FR-060**: The UI bridge MUST validate message origin, session, command, payload, size, and current grant before forwarding a UI command to the App runtime.
- **FR-061**: App UI MUST NOT receive dashboard cookies, general API credentials, parent DOM access, unrestricted navigation, or undeclared conversation, document, customer, or workspace data.
- **FR-062**: Loading, unavailable, denied, empty, degraded, and error states MUST remain within the App slot and MUST leave the surrounding Radioso surface accessible and usable.
- **FR-063**: The initial semantic slot catalog MUST be sufficient to prove an end-user control after an assistant message and an operator-facing App detail/report view without exposing generic DOM or route injection.

### Functional Requirements — Operations, observability, and contracts

- **FR-064**: Operators MUST be able to inspect each installation's active and prior release, health, contributions, attachments, grants, destinations, storage usage, circuit state, recent safe failures, scheduled work, queued deliveries, and available actions.
- **FR-065**: Operators MUST be able to disable an installation immediately, test a candidate update beside the active release, activate a validated update, roll back to an eligible prior release, and remove the App with explicit dependency and data-disposition handling.
- **FR-066**: Release quarantine MUST stop new executions across affected installations without deleting customer configuration or data and MUST provide operators an actionable reason and recovery state.
- **FR-067**: Rollback MUST NOT restore revoked credentials, removed permissions, prohibited destinations, quarantined artifacts, or incompatible data authority merely because an older release previously used them.
- **FR-068**: Lifecycle, invocation, storage, egress, event, schedule, webhook, UI-command, health, circuit, and quarantine paths MUST emit safe structured logs, low-cardinality metrics, audit events where operator/security accountability is required, and correlation identifiers suitable for traces.
- **FR-069**: Access-controlled logs, traces, audit records, and operator diagnostics MUST correlate workspace, installation, App, release, contribution, invocation/job, execution class, outcome, duration, retry/circuit state, and bounded resource counts without including raw customer content, prompts, completions, retrieved chunks, credentials, tokens, cookies, connection strings, or App payloads.
- **FR-069a**: Metrics MUST use bounded labels only, including contribution kind, execution class, outcome, retry class, circuit state, admission reason, sandbox state, and compatibility result. Workspace, App, release, installation, contribution, invocation, job, record, and principal identifiers MUST NOT be metric labels.
- **FR-069b**: Required telemetry MUST cover release admission, lifecycle duration/outcome, gateway overhead, warm/cold starts, handler duration, timeout/cancellation, sandbox capacity, queue age/depth, attempts/dead letters, circuit transitions, storage quota/query outcomes, egress denials, UI failures, and quarantine enforcement. Audit event families, access, retention, and successful-trace sampling MUST follow an explicit versioned observability policy; failures and security denials MUST remain diagnosable.
- **FR-070**: The dashboard, Ray, TypeScript SDK, and future clients MUST use the same server-owned installation plans, lifecycle transitions, grants, and diagnostics rather than independently interpreting App manifests.
- **FR-071**: Public App, release, installation, contribution, storage, test, lifecycle, and operational contracts MUST be described through the code-first OpenAPI surface and synchronized into the TypeScript SDK snapshot.
- **FR-071a**: The TypeScript SDK MUST expose ergonomic App resources over the generated contracts. The dashboard and Ray MUST call the same server-owned operations, and App operations added to Ray MUST satisfy permission, confirmation, target-scope, and descriptor-provenance parity before catalog registration.
- **FR-071b**: Each delivery slice MUST explicitly review the standalone MCP server and App-job/message-queue contracts. The initial program MUST NOT add direct App administration or App tool-list endpoints to MCP; an MCP `ask_agent` request MAY use an attached App-backed skill only through the normal assistant and skill policy path.
- **FR-072**: App author documentation MUST include manifest and contribution contracts, hosted-runtime protocol, local conformance testing, resource and egress rules, storage limits, UI bridge behavior, release admission, failure semantics, and security anti-goals.
- **FR-073**: Operator documentation MUST explain installation review, connections, data flow, residency, testing, activation, health, updates, rollback, disable, quarantine, uninstall, and data disposition.
- **FR-074**: The App contribution catalog MUST have conformance fixtures representing: WordPress-style document sync plus live commerce tools, Magento-style equivalent contributions, Notion-style OAuth document synchronization, and CSAT-style conversation UI plus managed feedback storage. These fixtures MUST require no App-specific conditionals in core product modules.
- **FR-074a**: The conformance mapping is normative: WordPress/WooCommerce uses a declarative connection, document source, incremental schedule, authenticated content webhook, commerce tool, declared egress, and lightweight cursor storage; Magento uses the same generic kinds with distinct commerce schemas and rate-limit outcomes; Notion uses OAuth, scheduled paginated document sync, checkpoint storage, deletion propagation, and reauthorization; CSAT uses an assistant-message UI slot, scoped submit command, managed feedback collection, operator App view, and export/deletion. These are fixtures, not vendor integrations promised by this program.
- **FR-075**: The default Radioso composition MUST build and run with the hosted App runtime unavailable or disabled; App functionality MUST degrade to explicit unavailable states without becoming a baseline dependency.

### Functional Requirements — WordPress connector migration

- **FR-076**: Release A MUST migrate every enabled WordPress connector configuration into one App Installation with an active WordPress App release, a Connection holding the site URL, application password, and webhook secret, the non-secret configuration values (post types, polling interval), and the sync cursor as a Managed App Storage record. Documents already ingested keep their external document IDs and source provenance so the App's next sync updates rather than duplicates them.
- **FR-077**: The legacy webhook path MUST continue to accept signed pushes from already-installed companion plugins and forward them to the installation-scoped gateway endpoint for the migrated installation, using the same shared secret, for at least one documented deprecation period. The Apps dashboard MUST show the new installation-scoped URL.
- **FR-078**: After migration, the in-process WordPress connector, its registration, its routes, and every WordPress-specific dashboard branch MUST be removed. The `ConnectorPlugin` contract remains only for channel connectors and MUST NOT register document-source connectors.
- **FR-079**: Migration MUST be idempotent, resumable, and auditable per workspace, and MUST leave a workspace on the in-process connector rather than half-migrated if any step fails.

### UI Tasks

- Add an Apps catalog and the Documents-menu entry that lists installed document-source Apps, replacing the hardcoded WordPress menu item, setup dialog, and download link.
- Render the manifest-declared setup guide and companion asset links generically inside the installation flow.
- Add an App release inspection and installation-review experience showing publisher trust, compatibility, contributions, requested authority, external destinations, data fields, storage, UI placement, resource expectations, and security status.
- Add connection and agent-attachment steps that reuse existing credential and OAuth patterns while clearly separating App installation from Agent Pack installation.
- Add an installation test experience showing conformance checks, suppressed side effects, proposed external calls, live-test approval, and actionable failures.
- Add an App installation detail experience showing health, active/prior release, contributions, agent attachments, permissions, data destinations, storage usage, queued work, recent safe failures, and lifecycle actions.
- Add update and rollback review experiences that emphasize newly requested authority and prevent accidental restoration of revoked access.
- Add disable, quarantine, removal, data-export, retention, and deletion confirmations with dependency impact.
- Add the minimum semantic UI-slot host needed for an end-user control after an assistant message and a sandboxed operator App view, including loading, empty, unavailable, denied, degraded, and error states.
- Add App-related Ray reads and proposals, or record explicit coverage-map exclusions for operations that must remain direct administrator actions.

### Key Entities

- **App**: Stable publisher-owned product identity and descriptive metadata across releases.
- **App Release**: Immutable signed version containing manifest, executable artifact identity, optional UI asset identity, contributions, permissions, egress, storage declarations, compatibility, conformance fixtures, and provenance.
- **App Installation**: One App installed in one workspace, with active/prior release pointers, lifecycle and health state, approved grants, resource policy, data residency, and operator ownership.
- **App Contribution**: Stable typed extension point declared by a release and instantiated under an installation.
- **App Attachment**: Explicit link from an installation or contribution to an agent, surface, or other supported target.
- **App Connection**: Installation-scoped binding to OAuth, secret, pairing, or external-service configuration managed through write-only credential flows.
- **App Grant**: Approved host capability, data projection, destination, UI context, or external egress authority for an installation and release.
- **App Runtime Instance**: Installation-isolated hosted sandbox state, including provisioned release, health, resource policy, lease, and scale state; never the durable data store.
- **App Invocation**: One authenticated, bounded execution with contribution, class, deadline, idempotency/cancellation state, safe outcome, and correlation identity.
- **App Job**: Durable event, schedule, webhook, or other asynchronous work item with lease, attempt, retry, checkpoint, and terminal state.
- **App Storage Collection**: Manifest-declared logical collection with versioned schema, indexes, query limits, retention, and quota.
- **App Storage Record**: Installation-scoped versioned value stored under a declared collection and record key.
- **App UI Session**: Short-lived capability for one frame, slot, visible entity, context projection, and command set.
- **App Installation Plan**: Immutable review result binding exact release, targets, connections, contributions, grants, egress, storage, Packs, conflicts, and expiry before mutation.
- **Agent Pack**: Optional declarative agent behavior distributed by an App and installed through a separate reviewed lifecycle.

### Assumptions

- The first release ships the WordPress App from a Radioso-owned built-in registry in every deployment profile, not a public marketplace. External publishers arrive with Release E.
- Radioso-authored Apps get no privileges beyond a third-party App; they prove the protocol.
- Publishers and executable registries are approved manually; releases are immutable and pinned by digest.
- Self-hosted deployments run Apps through the local-process provider shipped with the Compose stack; the Radioso Cloud sandbox provider is an operational choice, not a different App model.
- Publishers provide prebuilt executable artifacts. Radioso does not initially build arbitrary submitted source code.
- Each App Installation receives a sandbox containing only one workspace installation; idle installations may scale to zero.
- The hosted runtime protocol is language-neutral even if initial tooling favors the repository's TypeScript ecosystem.
- Managed App Storage serves lightweight document-shaped state. Apps with complex relational or high-volume models use disclosed external storage.
- Radioso may use existing infrastructure providers underneath runtime, queues, storage, secrets, and networking, but the App contracts do not expose provider-specific details.
- The initial hosted runtime supports one deployment region per installation and prevents silent cross-region processing; broader multi-region failover requires later policy work.
- Existing skills, routines, directives, documents, OAuth, audit, trace, and capability policies are reused through owning-module ports rather than duplicated by the App domain.
- WordPress/WooCommerce, Magento, Notion, and CSAT are conformance personas only; their actual vendor APIs, commercial agreements, and product-specific behavior remain outside this feature.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An authorized administrator can inspect, configure, safely test, and activate an approved reference App in under 10 minutes without editing code, manifests, or database state.
- **SC-002**: The WordPress, Magento, Notion, and CSAT conformance personas can each be expressed using the published contribution catalog with zero App-specific conditionals added to core chat, retrieval, routine, document, storage, gateway, or frontend-host modules.
- **SC-003**: Automated isolation tests produce zero successful cross-workspace, cross-installation, cross-App, cross-contribution, or expired-identity accesses across runtime, storage, secrets, events, webhooks, schedules, and UI sessions.
- **SC-004**: Disabling or quarantining an installation prevents 100% of new contribution executions, scheduled starts, event deliveries, webhook dispatches, storage access, and UI-session issuance within 5 seconds.
- **SC-005**: A failed, crashed, timed-out, invalid, rate-limited, or unhealthy App invocation always terminates within its enforced deadline, returns a typed outcome, and leaves the initiating conversation or core UI usable.
- **SC-006**: At least 99% of warmed interactive gateway invocations add no more than 300 milliseconds of platform overhead excluding App execution and external-provider time; cold-start contribution latency is measured and shown separately.
- **SC-007**: Duplicate delivery tests for events and external webhooks produce no duplicate App-visible effect when the App follows the published idempotency contract.
- **SC-008**: Interrupted install, update, rollback, disable, quarantine, removal, and data-disposition operations resume or compensate deterministically in 100% of fault-injection cases at defined lifecycle checkpoints.
- **SC-009**: A compatible candidate release can be tested beside the active release and activated or rolled back within 2 minutes without a partially visible contribution set.
- **SC-010**: Managed App Storage rejects 100% of undeclared collection, invalid-schema, unsupported-query, quota-exceeding, stale-version, and cross-installation test operations without corrupting accepted records.
- **SC-011**: Security inspection and automated tests find zero raw prompts, completions, document content, retrieved chunks, credentials, tokens, cookies, connection strings, or App payloads in App runtime logs, metrics, package metadata, and lifecycle audit metadata.
- **SC-012**: Every release, installation, grant, connection, contribution, invocation class, lifecycle transition, storage collection, event subscription, scheduled task, webhook, UI session, and quarantine action can be correlated through safe identifiers in operator diagnostics.
- **SC-013**: The default Radioso build and focused regression suite pass with no hosted runtime provider configured, proving Apps are optional and composition-owned.
- **SC-014**: Public App contracts, synchronized TypeScript SDK types/resources, App-author documentation, operator documentation, and Ray coverage or exclusions ship in the same change as their corresponding behavior.
- **SC-015**: After Release A, the WordPress App handles 100% of the retired connector's behaviors (signed push, poll, backfill, delete, indexed fields, facts content) through the App protocol only, and a repository search finds zero WordPress-specific identifiers in core backend modules, the frontend, or the connector registry.
- **SC-016**: 100% of enabled WordPress connector configurations migrate to App installations without operator re-entry of credentials, and pushes to the legacy webhook URL continue to be ingested throughout the deprecation period.
- **SC-017**: The same WordPress App artifact runs unchanged under the local-process provider and, once Release E lands, the sandbox provider, with identical conformance results.

### Measurement Protocol

The success criteria are cumulative program-end outcomes. For each release gate, only the criteria covering capabilities delivered by that release apply, while all previously applicable criteria continue to apply. Release A applies SC-001, the runtime, job, webhook, schedule, document-source, and storage portions of SC-003–SC-005 and SC-007–SC-008, SC-010–SC-016, and its stated User Story 7 scenarios, measured on the local-process provider; Release B adds the tool and event portions of SC-002–SC-009 and SC-012–SC-014; Release C adds context/UI portions of SC-002–SC-006 and SC-011–SC-014; Release D adds SC-009 and the Pack, update, and rollback portions of SC-008 and SC-012–SC-014; Release E must satisfy the complete SC-001–SC-017 set on the sandbox provider, including the isolation and cold-start measurements of SC-003–SC-006 that only that provider can demonstrate.

- **Administration timing (SC-001)**: Measure from opening the release-inspection page to successful activation using the pre-admitted WordPress App, a disposable WordPress test site, and a test workspace with administrator access. Run at least 20 first-time-user trials; the criterion applies to the 90th percentile and excludes external OAuth-provider outage time while retaining normal connection entry and safe-test time.
- **Abstraction conformance (SC-002, SC-014)**: Run the versioned persona fixtures against public manifest/runtime/storage/UI contracts and scan the owning modules for fixture App IDs. Contract, SDK, docs, Ray-coverage, and MCP/queue-impact checks are required gates for each release slice.
- **Isolation and enforcement (SC-003–SC-005, SC-010–SC-013)**: Use automated cross-tenant and fault-injection suites against disposable PostgreSQL plus the hosted-runtime test provider. Attempt each prohibited boundary directly and after disable, revocation, expiry, cancellation, and quarantine; success requires zero unauthorized accepted operations and no sensitive telemetry findings.
- **Performance (SC-006)**: Record environment, runtime provider version, App artifact digest, concurrency/load shape, sample count, clock boundaries, and warm/cold classification. Use at least 10,000 warmed invocations after stabilization; platform overhead is measured from gateway admission to sandbox dispatch plus result validation, excluding handler and external-provider time. Report p50, p95, p99, errors, and cold starts separately.
- **Delivery and recovery (SC-007–SC-009)**: Run duplicate event/webhook/schedule deliveries and crash injection at every documented lifecycle and App-job checkpoint. Measure update/rollback from approved apply request to active-pointer visibility under a healthy provider, while independently verifying that no candidate contribution was visible before the pointer change.
