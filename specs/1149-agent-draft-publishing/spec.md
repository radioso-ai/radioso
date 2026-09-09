# Feature Specification: Agent Draft Publishing

**Feature Branch**: `audit-agent-versioning`  
**Created**: 2026-09-08  
**Status**: Approved for implementation  
**Input**: Approved design in `.context/agent-publishing-design.md`, CEO review, and explicit implementation authorization.

## User Scenarios & Testing

### User Story 1 - Safely change an existing agent (Priority: P1)

An operator changes custom instructions, directives, routines, or the agent's selected context variables. Saving creates or updates that agent's private draft only. Customer-facing behavior continues to use the current published revision until the operator explicitly publishes a reviewed immutable candidate.

**Why this priority**: This prevents the demonstrated production-impact failure where an operator saved a directive and then tested it believing it was private.

**Independent Test**: Change all four scoped areas, save the draft, start a new production conversation, and prove it uses the old published revision. Publish the selected candidate and prove the next production conversation uses it.

**Acceptance Scenarios**:

1. **Given** an existing published agent, **When** an authorized operator saves a scoped edit, **Then** only its draft changes and the published pointer does not move.
2. **Given** a saved draft, **When** the operator creates a candidate, **Then** the candidate is immutable, coherent across all scoped areas, and remains unchanged by later draft edits.
3. **Given** a candidate with valid references, **When** an authorized operator publishes it with current concurrency tokens and an idempotency key, **Then** publication atomically moves the published pointer, records an audit event, and retries return the original result.
4. **Given** a stale draft generation or published pointer, **When** publication is attempted, **Then** it is rejected without changing the current pointer and the operator is required to refresh review.
5. **Given** draft edits made after a candidate was selected, **When** that candidate is published, **Then** the newer draft remains private; publication never reconstructs or overwrites it.

---

### User Story 2 - Test exactly the candidate being reviewed (Priority: P1)

An operator uses Test Chat to run one candidate or a two-version comparison. Each test conversation, stream, routine state, and eval run is bound to the selected immutable revision and validated sample inputs. Test behavior is isolated by the existing safe-test policy.

**Why this priority**: A test is trustworthy only if it is attached to the exact configuration the operator may publish.

**Independent Test**: Pin a candidate in a test conversation, modify the draft, and verify subsequent turns in that conversation remain on the original candidate. Run an aligned two-side comparison and demonstrate a failed side is shown as partial without rerunning the successful side.

**Acceptance Scenarios**:

1. **Given** a saved draft, **When** Test Chat starts, **Then** it materializes or reuses a candidate and binds the complete conversation before its first turn.
2. **Given** comparison mode, **When** one message is sent, **Then** both independently pinned conversations receive the same input, retain separate histories/routine state, and show separate outcomes.
3. **Given** a version, mode, or sample-value change, **When** a new test starts, **Then** previous executions are fenced from the new session and historical evidence remains labelled with its original identities.
4. **Given** selected context variables for either revision, **When** sample values are invalid, missing when required, or incompatible, **Then** testing fails with an explicit configuration error and never silently omits a value or uses a sample in production. Valid optional values retain their existing optional-value semantics.
5. **Given** test execution, **When** a skill or routine could make a production write, **Then** the existing safe-test dispatcher blocks or simulates it; a path that cannot honor the policy fails rather than performing a live action.

---

### User Story 3 - Use eval evidence without making it a gate (Priority: P2)

An operator selects existing eval cases and runs them against a candidate or both sides of a comparison. Results preserve revision, case snapshot, sample input, execution-policy, and relevant dependency/model/settings provenance, so the UI can state freshness and partial outcomes accurately.

**Why this priority**: Evals help an operator judge a release but must not imply deterministic correctness or block a deliberately informed publication.

**Independent Test**: Start an eval against a candidate, change the draft, and prove the queued/retried work completes against the original candidate. Verify missing, running, partial, failed, and completed outcomes remain distinct and publication remains allowed after a failed or absent eval.

**Acceptance Scenarios**:

1. **Given** selected cases and a candidate, **When** an eval run is created, **Then** revision, case versions/snapshots, test inputs, and execution policy are frozen before dispatch.
2. **Given** a delayed, retried, or duplicate worker delivery, **When** it executes, **Then** it uses the stored identities, is idempotent by run/case execution identity, and reports partial progress.
3. **Given** changed candidate, case, sample inputs, or tracked environment, **When** old evidence is displayed, **Then** it is labelled configuration-changed or environment-changed; untracked live dependencies are comparability-unknown.
4. **Given** no evals, incomplete evals, or failed evals, **When** the operator publishes an otherwise valid candidate, **Then** publication is permitted and the evidence state remains explicit.

---

### User Story 4 - Release safely across channels and lifecycle changes (Priority: P2)

One agent has one published revision shared by every channel. New production conversations resolve the current pointer. Ongoing conversations keep the revision selected when they began. New or imported agents remain private until their explicit first publish, while existing agents are backfilled live without behavior change.

**Why this priority**: The publication boundary must work consistently for every entry surface and preserve in-flight behavior during rollout.

**Independent Test**: Publish while a production conversation is open, then prove its later turns retain its starting revision and a newly started conversation uses the new pointer. Create/import an agent and prove live entry points return an explicit not-published result until first publication.

**Acceptance Scenarios**:

1. **Given** a newly started conversation on Web chat, website embed, REST API, SDK, MCP, Slack, or WhatsApp, **When** it resolves the agent, **Then** it binds the current published revision once before its first turn.
2. **Given** an ongoing conversation, worker handoff, or resumption, **When** a later candidate is published, **Then** it continues with its starting revision while live authorization, credential revocation, agent disablement, and safety controls still apply.
3. **Given** an existing agent at cutover, **When** migration completes, **Then** it has an equivalent initial published revision and matching draft; preserved unpublished authoring work remains visibly dirty rather than becoming live.
4. **Given** a new or imported agent, **When** it has never been published, **Then** operators may test it but public channels receive an explicit not-published outcome.
5. **Given** a routine referenced by a pinned revision or active routine state, **When** its authoring row is archived or removed, **Then** the retained immutable definition/closure remains executable or the system explicitly blocks unsafe migration; it never silently reinterprets state.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST maintain one mutable private draft, immutable candidate revisions, a current published revision pointer, publication history, base-published metadata, and generation tokens per agent.
- **FR-002**: A revision MUST contain the full runtime-relevant projection of custom instructions, directive definitions plus enablement/order metadata, selected routine definitions with complete executable closure and membership/order metadata, and per-agent context-variable enablements. Disabled content is retained but is not executable.
- **FR-003**: Shared context-variable definitions, documents/retrieval content, providers, credentials, external services, generic skills, and non-scoped agent/workspace settings remain live dependencies and are outside the revision boundary.
- **FR-004**: All scoped writers, including dashboard, REST API, SDK, MCP, Ray/operator-copilot, import/restore, and routine lifecycle paths, MUST mutate the draft through one authorized aggregate boundary. Legacy save calls must have explicit draft semantics and MUST NOT imply publication authorization.
- **FR-005**: Candidate creation and publication MUST validate workspace/agent ownership, permissions, scoped graph consistency, routine/reference integrity, and selected context-variable availability. No missing or invalid candidate may fall back to live authoring rows.
- **FR-006**: Publication MUST use an expected draft generation and published-pointer token, an idempotency key, short transactional pointer update, and an audit event. It MUST not call providers or run evals inside that transaction.
- **FR-007**: A conversation MUST persist its bound revision identity before its first turn. Conversation resumptions, routine state, and relevant worker handoffs MUST carry that identity. New conversations resolve the pointer; ongoing conversations retain their starting revision.
- **FR-008**: Draft test chat and eval execution MUST require operator authorization and must use the established safe-test dispatcher. Public channels MUST NOT select arbitrary draft/candidate IDs.
- **FR-009**: Eval persistence MUST retain candidate revision ID, immutable case identity/snapshot, test-input identity, execution policy, and applicable model/settings/dependency fingerprints. These values are provenance and MUST NOT be emitted as high-cardinality metrics or expose sample values.
- **FR-010**: The system MUST preserve distinct missing, running, partial, failed, and completed execution states. It MUST support retrying one failed comparison side using the original input/state without rerunning a successful side.
- **FR-011**: Existing agents MUST be backfilled with an equivalent published revision and matching draft. Open legacy conversations are classified and mapped only when safe; unsafe active routine state or non-equivalent history is surfaced for resolution. Old workers are drained or blocked before accepting revision-bound jobs.
- **FR-012**: Newly created and imported agents MUST start unpublished. Their completion flow exposes private test/review/first-publish; public channels return an explicit not-published result until publication.
- **FR-013**: The operator cockpit MUST show agent identity and selection in an expandable sidebar agent list with New agent access. The selected agent contains a Channels dropdown with enabled channels and a final Manage channels link to a real overview. Above Test Chat, Profile, Directives, Routines, Skills, and Context tabs, a compact header shows draft/publication status and the relevant save or publish action without duplicating agent identity. Channel settings remain outside draft publication and do not show cockpit tabs or publication controls. Status and actions sit in the title row. A permitted operator can open Review & publish for a clean saved draft; unsaved scoped changes expose Save draft & send.
- **FR-014**: Test Chat MUST provide saved-draft default, immutable revision labels, single and two-side comparison flows, optional Test context for enabled variables, revision-aware eval controls/results, and explicit loading/permission/configuration/unavailable/partial states. Changing revisions, mode, or samples begins fresh fenced execution without deleting evidence.
- **FR-015**: The UI MUST preserve current routing, deep links, permissions, unsaved-edit protections, keyboard/focus behavior, and existing editor/eval authoring surfaces. Long tab rows must remain accessible at narrow widths.
- **FR-016**: The system MUST record useful, content-safe publication/test/eval observability and audit correlation (workspace, agent, revision, execution/run identifiers, outcome/failure category) without prompts, completions, chunks, sample values, credentials, cookies, or connection strings.
- **FR-017**: API changes MUST be code-first OpenAPI changes with generated snapshots and SDK synchronization. Cross-service payload changes MUST review queue dispatch, retry semantics, test coverage, and documentation.
- **FR-018**: Published revisions MUST have stable per-agent version numbers displayed as v1, v2, and so on. Only a new successful publication allocates a number; saves, candidate creation, tests, and idempotent publication retries do not. Existing published revisions receive deterministic numbers. Drafts show their published base when available; normal UI does not expose revision hashes or draft generations.
- **FR-019**: Test Chat MUST retain the shared chat thread and composer presentation, with History accessible from the title-row overflow menu. Comparison, New chat, Evals, and optional Test context also live in this menu; eval and context controls open on demand. New private single and comparison executions persist as reopenable history with exact revisions, samples, side histories, and retry identities. Existing legacy private test history remains accessible with honest provenance. Private tests never appear in production Activity.
- **FR-020**: Sending the first message MUST create the selected single or comparison execution automatically when a fresh execution has not already been created for an enabled proactive greeting. When proactive greeting is enabled, opening a fresh Test Chat MUST create the selected execution before the user message, persist the assistant greeting as initial side history, and use the configured fallback locale when the request has no locale. When proactive greeting is disabled, the execution remains lazy until the first message. New chat clears the visible conversation while retaining history and ongoing eval evidence for unchanged inputs, then starts a fresh greeting when enabled. Changes to revisions, mode, or samples prepare a fresh execution.
- **FR-021**: If scoped authoring is unsaved, Test Chat MUST offer Save draft & send, await the actual successful private save, and resolve the resulting immutable candidate before execution. Failed saves MUST prevent provider dispatch; live settings must not be implicitly saved through this action.

### UI Tasks

- Show compact draft/published status and explicit scope on the agent header; keep identity in the sidebar and Profile.
- Use the approved horizontal cockpit while retaining sidebar agent creation/selection, nested channel navigation, and existing deep links.
- Provide single and comparison Test Chat with aligned input, independently pinned revisions, restart notices, Test Values validation, and revision-labelled evidence.
- Put candidate-aware eval selection/results in Test Chat and link existing eval authoring/history surfaces.

### Non-Goals

- Full revision history/restore UI, branching, scheduling, new approval roles, mandatory eval gates, or per-channel drafts/published pointers.
- Versioning shared variable definitions, documents, retrieval indexes, models, providers, generic skills, credentials, external services, or workspace settings.
- A new eval authoring product, a parallel test engine, or guarantees of deterministic answers/replay when dependencies are live.

## Success Criteria

- **SC-001**: A scoped save cannot change behavior of a newly started production conversation until explicit publication succeeds.
- **SC-002**: Every production, test, and eval execution can identify the immutable agent revision it used; a later draft edit or publication cannot alter that identity.
- **SC-003**: A publish retry after a lost response returns the original publication result without producing a second pointer movement or audit publication.
- **SC-004**: Existing agents retain equivalent effective behavior through migration, and no new/imported agent is reachable on public channels before first publication.
- **SC-005**: Comparison and eval evidence visibly identifies partial, stale, configuration-changed, environment-changed, and comparability-unknown states without treating them as passes.
- **SC-006**: All scoped writer surfaces follow the draft boundary and all public runtime readers resolve published/pinned revision content without an authoring-table fallback.

## Approved Decision and Implementation Assumptions

- D1 is user-approved: ongoing conversations keep the revision bound at their start; new conversations use the current published revision.
- D2 is the documented implementation assumption under the user's proceed authorization: new/imported agents are private until explicit first publish; existing agents are backfilled live.
- Existing channel-specific context and capability restrictions remain runtime inputs; they do not create channel-specific release lifecycles.
- The existing safe-test dispatcher is sufficient only where it can block/simulate an action; paths outside its coverage must fail closed. Any writer surface that cannot route through the draft aggregate is a blocking compatibility gap, not a permitted exception.
- The direct-write behavior of existing API/SDK/MCP/routine endpoints is materially incompatible with private drafts. This feature changes those endpoints to draft writes and adds an explicit publication action; release notes and contract migration guidance are required.

## Key Entities

- **Agent Draft**: Mutable, private scoped configuration with base published revision and generation.
- **Agent Revision**: Immutable executable snapshot of the scoped configuration and validated routine closure.
- **Publication**: Idempotent record and atomic current-published-pointer transition.
- **Revision Binding**: Stored relation from a production/test conversation, routine state, eval run, or queued execution to its immutable revision.
- **Evidence Provenance**: Frozen case/input/policy/dependency identities used to describe what an eval or test ran.
