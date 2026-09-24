# Feature Specification: Confirmed Operator MCP Authoring

**Feature Branch**: `1150-operator-mcp-authoring`

**Created**: 2026-09-13

**Status**: Approved — user authorized implementation on 2026-09-13

**Input**: Add complete routine editing, retrieval configuration, and explicit agent publication through Operator MCP. The user confirmed: “Yes, mcp should be able to do everything, with a confirmation.”

## Scope

An authorized operator must be able to complete the discussed authoring workflow in an MCP conversation without opening the dashboard or a confirmation page: inspect configuration, prepare changes, review their exact effects, confirm and apply them, and separately confirm agent publication. The agent presents the proposed action, the person confirms in the conversation, and the trusted MCP client permits execution. This is Operator MCP, not the agent-channel `ask_agent` interface.

In scope: routine definitions and structure; inspection of code-owned system retrieval defaults; mutation of existing per-agent retrieval settings; proposal review/application; agent revision inspection, candidate preparation and publication; retrieval probes; conversational confirmation and execution-result retrieval; tool discovery and usage guidance.

Out of scope: unrestricted administration, arbitrary HTTP execution, document upload/deletion or reprocessing, new retrieval algorithms, provider credentials, new model-management controls, persisted workspace retrieval-default overrides, and unrelated MCP capabilities. The current `/settings/retrieval-defaults` surface exposes code-owned system defaults; it is not a writable workspace setting. Existing validation restrictions remain in force; a setting unsupported at a particular scope must not become writable merely because another scope supports it.

## Clarifications

### Session 2026-09-13

- Q: Should approval, application, and publication be possible inside the MCP client? → A: Yes, the MCP client should support the full discussed workflow with confirmation.
- Sequential flow means “continue to the next step”; a jump means “go to this specific step.” Structural operations must expose their actual connection changes for review and must not claim to preserve a distinction the stored model cannot represent.
- Q: Must confirmation open a separate page? → A: No. The agent proposes publishing the new version and the person confirms in the conversation. The MCP client is trusted to obtain and honor that confirmation; the server does not claim independent proof of human presence.
- Review resolution proposed for approval: retrieval writes target existing per-agent controls. System defaults remain inspectable but read-only; adding workspace-persisted defaults would be a separate feature.
- Q: Should publishing receive a separate permission from general confirmed writes? → A: No; retain the general write permission and proceed with implementation. Publishing still requires confirmation of the specific reviewed revision.

## User Scenarios & Testing

### User Story 1 — Edit a routine from an MCP client (Priority: P1)

An operator asks an MCP-connected assistant to create or modify a routine, reviews a proposed change, and confirms application to the private draft.

**Why this priority**: Current MCP routine edits exclude structure and cannot apply their own proposals.

**Independent Test**: Starting with an existing routine, insert and reorder steps, edit an explicit jump and a conditional branch, preview the resulting flow, confirm application, and verify the persisted draft through both MCP and the editor.

**Acceptance Scenarios**:

1. **Given** a routine with sequential steps and conditional branches, **when** an operator requests a structural edit, **then** a proposal shows the resulting steps, affected connections, diagnostics, and draft-only impact without mutating the routine.
2. **Given** that proposal, **when** the operator confirms it, **then** only the reviewed changes are applied and published behavior remains unchanged.
3. **Given** an explicit jump, stable step references, or scoped directives, **when** other steps are edited, **then** unrelated references remain intact; destructive reference changes are shown explicitly or rejected with actionable diagnostics.
4. **Given** declined or absent conversational confirmation, **when** the trusted client considers execution, **then** it sends no execution call. **Given** an expired or canceled reviewed operation, **when** execution is attempted, **then** the server rejects it without a configuration change.

### User Story 2 — Tune retrieval with a confirmed change (Priority: P1)

An operator inspects system defaults and tunes existing agent retrieval settings through MCP, then checks behavior with the existing retrieval probe.

**Why this priority**: Read/probe access alone does not let an MCP-connected operator manage retrieval.

**Independent Test**: Change agent source selection and ranking/filter settings, confirm the changes, read back the results, and verify omitted settings and read-only system defaults are preserved.

**Acceptance Scenarios**:

1. **Given** an agent and workspace, **when** the operator inspects retrieval settings, **then** MCP distinguishes effective values, scope and inheritance where supported, editable fields, and settings that are unavailable at that scope.
2. **Given** a valid change to source selection, metadata filtering/boosting, retrieval strategy, result limits, reranking, query rewriting, temporal behavior, retrieval instructions, or suggested questions, **when** it is proposed, **then** the preview identifies the target scope and whether application changes a draft or live behavior.
3. **Given** a request to change a code-owned system default, **when** MCP evaluates the request, **then** it explains that the default is read-only and offers a supported per-agent override where one exists; it does not invent a workspace write.
4. **Given** an agent-level setting, **when** it is changed, **then** its existing lifecycle is preserved and reported accurately; this feature does not silently move settings into or out of agent revisions.
5. **Given** a retrieval probe with diagnostic overrides, **when** it completes, **then** it does not persist those overrides as settings.

### User Story 3 — Review and publish an agent from MCP (Priority: P1)

An operator reviews the exact saved draft revision and separately confirms publication without opening the dashboard.

**Why this priority**: Applying a draft is not equivalent to releasing it to new conversations.

**Independent Test**: Prepare and inspect a candidate, confirm publication, verify a new conversation uses that revision, and verify an existing conversation retains its prior revision.

**Acceptance Scenarios**:

1. **Given** saved draft changes, **when** a publication candidate is prepared, **then** the operator can inspect its complete release diff and validation results without publishing it.
2. **Given** a valid candidate, **when** publication is explicitly confirmed, **then** new conversations use that candidate while existing conversations remain pinned according to current behavior.
3. **Given** a draft or published revision changed after review, **when** the old confirmation is used, **then** publication is rejected and a new preview and confirmation are required.
4. **Given** a successful application or publication whose response was lost, **when** the client retries or queries its outcome, **then** it can reconcile the original result without duplicating the mutation.

### Edge Cases

- Cross-workspace targets, insufficient permissions, revoked grants, and revoked sessions.
- A client or unattended automation unable to obtain conversational user confirmation; it must not execute writes under this workflow. Server-side validation cannot independently detect a trusted client falsely claiming confirmation.
- Declined or absent conversational confirmation; canceled, expired, replayed, tampered, or target-mismatched reviewed operations.
- Concurrent edits from the dashboard or another MCP client, including an unchanged payload with a changed target version.
- Duplicate step identifiers, missing targets, unreachable endings, cycles unsupported by existing validators, and removal of referenced steps/slots/endings.
- A default edge adjacent to its destination: structural commands must not infer permission to rewire it from adjacency. Connections change only through the explicit transform contract below.
- Requests spanning settings with different existing lifecycles; confirmation must distinguish the effects and report partial outcomes honestly if operations are separate.
- Invalid source IDs, unsupported retrieval settings, out-of-range values, malformed metadata rules, and omitted-versus-explicitly-cleared fields.
- Candidate validation fails because a referenced dependency changed or was removed.

## Constitution Constraints

- Implementation, planning, and task breakdown must wait for approval of this spec.
- Backend changes follow failing-test-first TDD. Visible client/editor journeys use end-to-end tests; shared transformations use focused unit tests.
- Preserve the established Node.js, React, PostgreSQL/pgvector stack, provider defaults, design system, secret handling, and runtime prompt ownership. No new provider or styling work is required.
- Preserve least-privilege access, secure transport, and workspace isolation. Tool arguments or retrieved content cannot grant authority.
- Keep transport, orchestration, domain rules, and persistence separate. Evaluate composition ownership for new confirmation or execution adapters.
- Regenerate applicable OpenAPI, SDK, and MCP artifacts when contracts change. Do not hand-edit generated snapshots.
- Review message-queue impact and document whether worker dispatch, retry semantics, payloads, or queue documentation require changes.
- Update operator MCP documentation, tool descriptions, coverage maps, and relevant authoring/retrieval documentation in the same delivery.

## Architecture Constraints

- **Boundary Rule**: The trusted client owns conversational confirmation. Operator MCP owns protocol adaptation and authenticated invocation. A shared reviewed-execution boundary owns intent binding and execution lifecycle. Routine, retrieval, and agent-revision domains retain validation and persistence rules.
- **Encapsulation Rule**: MCP routes must not implement graph rewriting, retrieval policy, publication rules, or ad hoc SQL. Backend code must not import frontend helpers. Generic confirmation logic must not know routine or retrieval schema details.
- **New Seams Required**: Transport-neutral structural routine editing shared with or demonstrably equivalent to editor behavior; narrow ports for confirmed proposal application and candidate/publication operations; validated retrieval-setting mutations at their existing scopes.
- **Dependency Direction**: Transport and composition depend on narrow domain/application ports. Domains do not depend on MCP, React, or composition. Reuse existing proposal validation, version fencing, publication, and auditing rather than creating parallel implementations.
- **Anti-Goals**: No generic unrestricted mutation tool; no claim that `confirmed: true` proves human presence; no confirmation pages or out-of-band approval ceremony; no automatic publication inferred from a request to edit; no duplicate frontend/backend graph algorithms; no English keyword heuristics for interpreting operator intent.
- **Observability**: Record safe audit and correlation data for proposal, confirmation, application, publication, conflicts, and retry reconciliation. Do not log prompts, retrieved content, credentials, confirmation secrets, or unredacted sensitive setting values.

## Requirements

### Confirmation and execution contract

- MCP prepares a reviewed operation and returns its operation identifier, exact target/diff, draft/live effect, relevant future action risks, expected versions, and expiry. Preparation must not execute the proposed configuration change.
- The agent presents the proposal in the conversation and asks the person to confirm. Publication confirmation identifies the exact new revision and its effect on new versus existing conversations. A user request to prepare or edit a draft is not confirmation to publish it.
- The trusted MCP client/agent interaction must wait for the person's affirmative response before invoking the separate execution tool for that reviewed operation. No browser page, separate login, out-of-band approval, or prescribed English confirmation phrase is required. Decline or cancellation must not produce an execution call.
- **Trust boundary**: conversational confirmation is enforced by the trusted MCP client, not independently proven to Radioso by the protocol. A write-authorized client can technically invoke execution without asking a human. The grant/consent description and documentation must state this limitation rather than represent a tool argument, operation token, or audit entry as proof of human presence. Operators must grant write access only to clients they trust to honor confirmation.
- The execution request references the server-stored reviewed operation and is bound to its content digest, operation kind, target, expected versions, principal, workspace, originating grant/client, and expiry. It authorizes one logical execution only. Changed content or target state requires a newly reviewed proposal and renewed conversational confirmation.
- Execution rechecks permissions, grant validity, expiry, and version fences. Lost responses reconcile to the same logical result; declining/canceling before execution prevents mutation. Cancellation racing with execution must return the actual committed outcome rather than claim rollback.
- Applying edits and publishing an agent are separate approvals. A single approval cannot authorize an open-ended sequence of future edits or an unspecified future revision.
- Preparing proposals and immutable candidates is a bounded, non-serving review-artifact write. It requires its own grant and domain permission but not execution confirmation. Preparation must be idempotent for a supplied operation identifier (a preparation without one runs unkeyed, so its retry can leave a second pending artifact for review), have explicit retention/cleanup rules, and never change active configuration or publication.

### Structural editing contract

The stored graph has explicit targets, not a persisted distinction between an unconditional jump and an automatic continuation. MCP must therefore use explicit, deterministic edits rather than adjacency-based intent inference:

| Operation | Required behavior |
|---|---|
| Add step | Supply a unique stable identifier, supported step definition, and position. Connections are unchanged unless explicit connection edits accompany the addition. |
| Reorder | Supply the complete ordered set of existing step identifiers. Change ordinals only; preserve every transition target and condition. Revalidate order-sensitive back-edge rules. |
| Insert into flow | Identify the exact existing edge to split and the new step. Preserve that edge's condition while changing its destination to the new step; add an unconditional edge from the new step to the original destination. If the identified edge is absent, stale, ambiguous, or incompatible with the new step's required exits, reject instead of guessing. |
| Retarget/change condition | Identify the exact existing edge and explicit replacement target/condition. Preserve every unmentioned edge. |
| Remove step/slot/ending | Reject while referenced unless the same atomic edit explicitly removes or replaces every affected reference, including relevant scoped directives. Never silently drop or reassign them. |
| Reorder execution sequence | Express as ordinal changes plus explicit edge edits in the same reviewed operation. Do not silently reinterpret a fixed target as “next row.” |

Multiple edits are validated and applied atomically to one routine draft, not as partially applied graph mutations. Invalid intermediate states may occur inside the proposed edit sequence; the persisted result must satisfy existing authoring validation policy. Unservable drafts must remain clearly diagnosed and cannot be published.

Acceptance cases must cover each transform against unconditional/default, guarded, terminal, and order-sensitive/back-edge connections, including insert-before-terminal, multiple incoming edges, a jump whose target happens to be the next row, and a reference changed after preview. MCP need not reproduce an ambiguous UI drag operation: equivalent explicit ordinal-and-edge operations must produce equivalent graphs.

### Routine effect restrictions

- Authoring may reference only existing, authorized capabilities and destinations. It cannot create credentials or destinations, expand their permissions, bypass approval steps, or weaken the existing never-list.
- Changes that arm future tool/action execution or completion export must show the affected capability/destination identifiers, enablement, existing approval requirements, and possible external effects in both application and publication review.
- Configuration approval is not approval to execute a future customer action. Runtime consent and capability policy remain independently enforced; current prohibited unattended replies and provider/secret writes do not become allowed through a routine.
- If a supported routine setting cannot meet these boundaries, reject that edit with a documented capability-specific reason rather than silently accepting a weaker safety contract.

### Grant and operation classification

Introduce a narrowly described `operator:write` scope for the confirmed in-scope mutations. Existing grants, including `operator:act` and `operator:propose`, do not implicitly gain it; the operator must explicitly consent to the new scope for the chosen client, thereby trusting that client to obtain conversational confirmation. No proprietary host attestation or new human-presence protocol is required. The write scope is a ceiling, not proof of confirmation, and never replaces domain permissions. Scope contracts, consent text, persistence constraints, metadata, and generated contracts must be updated together.

| Operation | MCP grant | Descriptor effect | Domain permission | Confirmation | Retry/reconciliation | Lifecycle |
|---|---|---|---|---|---|---|
| Read routine/configuration/revisions/system defaults; validate | `operator:read` | none | Existing target read policy; agent/routine targets require `workspace.agents.read` | None | Read-only retry | No mutation |
| Retrieval probe | `operator:probe` | none | `workspace.retrieval.query` and `workspace.agents.read` | None | Diagnostic re-run; no config write | No config mutation |
| Prepare routine/retrieval change proposal | `operator:propose` | proposal | `workspace.agents.manage` | None | Optional client operation ID resolves the same prepared artifact; without one a retry can prepare a second artifact | Review artifact only |
| Prepare publication candidate | `operator:propose` | proposal/review artifact | `workspace.agents.manage` | None | Optional client operation ID plus draft generation | Immutable review artifact only |
| Apply routine create/edit/enable/delete | `operator:write` | act | `workspace.agents.manage` | Conversational confirmation enforced by trusted client | Keyed by the client operation ID, otherwise proposal ID and reviewed digest; routine/draft version fence | Private draft; no publication |
| Apply per-agent retrieval changes | `operator:write` | act | `workspace.agents.manage` | Conversational confirmation enforced by trusted client | Keyed by the client operation ID, otherwise proposal ID and reviewed digest; settings version fence | Existing setting lifecycle, explicitly shown in preview |
| Publish reviewed agent candidate | `operator:write` | act | `workspace.agents.manage` | Separate conversational publication confirmation | Keyed by the client operation ID, otherwise proposal ID and reviewed digest; candidate ID, draft generation and published-revision fence | Changes revision for new conversations |
| Read/cancel/reconcile own execution | `operator:write` | operation lifecycle only | Initiating principal/workspace/client binding and current target permission | No additional approval for reading/canceling | Optional client operation ID; a repeated cancellation returns dismissed; cancellation only before any execution receipt is bound | Cannot create a new configuration change |

Revoked credentials remain invalid for every MCP call, including lifecycle reads and cancellation; this feature does not introduce a revocation bypass. An already-started operation with an uncertain result must be reconciled, not reported as canceled merely because its execution lease expired.

The execution endpoint checks the originating write grant and target permissions; another principal/client or a client with only proposal scope cannot apply the operation. Operation identifiers are not bearer authority. Expired/revoked grants cannot resume execution.

### Functional Requirements

- **FR-001**: Operator MCP must expose the full in-scope inspect → propose/prepare → review → confirm → apply workflow; publication must be a distinct explicitly confirmed operation.
- **FR-002**: Routine authoring must support create/delete, enable/disable, existing field edits, add/remove/reorder steps, edit transitions and conditions, and manage supported step settings, slots, and endings without requiring dashboard use.
- **FR-003**: Structural changes must follow the deterministic transform contract, reuse canonical validation, and preserve stable identifiers and references where unaffected. Previews must show changed execution connections, not only visual row order.
- **FR-004**: Retrieval mutation must cover existing supported per-agent retrieval controls, with scope-specific validation and omission-preserving updates. System-default inspection and existing read/probe tools must remain available; system defaults remain read-only.
- **FR-005**: Proposals must state exact target, before/after changes, validation results, affected scope, and draft/live impact before confirmation.
- **FR-006**: The trusted MCP client must obtain conversational user confirmation before invoking execution, following the contract above. The server must enforce reviewed-operation binding and authorization, without claiming independent verification of human presence.
- **FR-007**: Applying a proposal, deleting a routine, writing retrieval settings, and publishing must require appropriate permissions and explicit confirmation. Preparing a preview does not authorize its application or publication.
- **FR-008**: Authorization and target freshness must be rechecked at execution time. Changed content, targets, permissions, or relevant versions invalidate prior confirmation.
- **FR-009**: Confirmed operations must support safe retries and outcome reconciliation without duplicate mutation. Canceled or unconfirmed operations must not mutate configuration.
- **FR-010**: Agent publication must retain existing candidate validation, draft-generation checks, current-publication checks, and immutable conversation pinning.
- **FR-011**: Existing dashboard flows, agent-channel MCP behavior, and supported clients must not regress. MCP and dashboard must read the same resulting state.
- **FR-012**: Tool discovery and documentation must teach supported settings, scope, graph semantics, confirmation requirements, and the difference between applying a draft and publishing an agent.
- **FR-013**: All in-scope operations must be represented in the capability coverage map with explicit permissions, confirmation classification, and supported lifecycle.

### Key Entities

- **Reviewed change**: Target, expected version, proposed values/structure, diff, diagnostics, and stated impact.
- **Confirmation**: The person's acceptance of a specific reviewed change in the MCP conversation, honored by the trusted client. Server audit records attribute the subsequent execution to the authenticated client/principal, not independently verified human presence.
- **Execution outcome**: Reconciliable status linking the reviewed change to its applied result or failure.
- **Routine graph**: Stable steps, transitions, conditions, slots, and endings governed by existing domain validation.
- **Retrieval configuration**: Read-only code-owned system defaults and writable existing agent-scoped settings, with scope-specific capabilities and lifecycle.
- **Agent revision candidate**: Immutable reviewed release content linked to the expected draft and publication state.

## Success Criteria

### Measurable Outcomes

- **SC-001**: An operator can complete all three user stories in a supported MCP conversation, confirming proposed actions without opening another page.
- **SC-002**: Client-interaction tests prove no execution call occurs before confirmation or after decline. Server tests separately prove insufficient authority, wrong workspace/client, expired or mismatched reviewed operations, and stale state cannot change configuration. Review-artifact preparation has separate authorization, idempotency, and no-serving-effect tests. Tests must not claim the server detects a dishonest write-authorized client bypassing its confirmation obligation.
- **SC-003**: Every structural transform has exact before/after graph acceptance tests proving that only explicitly identified connections and ordinals change; equivalent explicit editor and MCP edits produce equivalent graphs.
- **SC-004**: Existing retrieval fields remain unchanged when omitted, and every accepted field can be read back at its correct scope after a confirmed change.
- **SC-005**: Retry and lost-response tests demonstrate a single applied effect and a recoverable outcome for application and publication.
- **SC-006**: Local MCP end-to-end verification covers actual confirmation, routine changes, retrieval changes, and publication against a disposable workspace; fresh-build regression tests and required GitHub checks pass before handoff.

## Assumptions

- “Everything” is bounded to routine authoring, existing per-agent retrieval configuration, and agent release management discussed above, not all product administration or a new workspace-default persistence system.
- Existing authentication and permission systems remain the source of authority; new MCP grants may be necessary but must remain narrowly scoped.
- Read-only inspection and probes retain current permissions and do not require mutation confirmation. Preparing a proposal/candidate may persist review artifacts but cannot change serving behavior.
- System defaults stay read-only. Agent retrieval settings retain their existing lifecycle; the confirmation preview makes that lifecycle explicit rather than redefining it.
- The branch was renamed to `1150-operator-mcp-authoring` at the user's request. Only Terra/Luna perform coding; the primary agent coordinates and verifies.
