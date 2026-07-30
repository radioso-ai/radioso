# Feature Specification: Quality Resolution and Eval Learning Loop

**Feature Branch**: `954-quality-eval-loop`  
**Created**: 2026-07-30  
**Status**: Approved for implementation  
**Input**: User description: "Implement GitHub issue #940. Before coding, choose the best operator UI and public API for structured triage resolution reasons and an Eval verification learning loop."

## Existing Behavior And Feature Delta

Quality currently lets an operator move an assistant turn between `open`,
`acknowledged`, `resolved`, and `dismissed`. The stored triage row has one
optional free-text `reason`, but neither Quality nor Needs Attention asks for or
displays it. State writes overwrite unconditionally, so two operators can
silently replace each other's decisions. Reopening behavior and transition
history are not defined.

Quality also offers “Open in Eval,” but the client must list every Eval case,
fetch snapshots one by one, compare source message identifiers, and otherwise
capture a snapshot and create a case in separate requests. The action can race,
has no stable one-case-per-turn identity, and Quality cannot show whether the
linked case later passed.

This feature makes closure structured and turns Eval into visible verification:

1. terminal triage records one actionable reason and an optional note through a
   shared close-review flow;
2. every triage transition is concurrency-safe and auditable, with explicit
   reopen behavior;
3. one idempotent Eval operation finds or creates the case associated with an
   assistant message;
4. Quality exposes a lightweight, current Eval verification projection without
   owning Eval behavior;
5. operators can see, filter, and aggregate what closed reviews taught them.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Close A Review With A Useful Reason (Priority: P1)

A workspace operator can resolve an actionable Quality item or mark a
non-actionable item accordingly, select one concise reason, optionally leave a
note, and return to the queue without losing their place.

**Why this priority**: A terminal state without a reason clears work but teaches
the operator nothing. Requiring one short classification creates useful data
without turning routine triage into a form-filling exercise.

**Independent Test**: Close turns from both the Quality table and the negative
feedback Needs Attention drawer using every supported reason, verify validation,
queue removal, announcements, focus restoration, persistence, and subsequent
display.

**Acceptance Scenarios**:

1. **Given** an open or acknowledged turn in Quality, **When** the operator chooses Resolve, **Then** one shared close-review dialog requires a resolved reason and allows an optional note.
2. **Given** an open or acknowledged negative-feedback item in Needs Attention, **When** the operator chooses Mark resolved, **Then** the same reason vocabulary and close-review interaction are used.
3. **Given** an item the operator considers non-actionable, **When** they choose Not actionable, **Then** the dialog shows only not-actionable reasons.
4. **Given** the operator chooses `other`, **When** the note is empty, **Then** completion is blocked with an accessible explanation.
5. **Given** a valid terminal decision, **When** it succeeds, **Then** the item leaves the active queue, success is announced without relying on color, and focus moves predictably to the next item or page heading.
6. **Given** a previously closed turn, **When** the operator views it with closed items included, **Then** its state, structured reason, optional note, and closure time are visible.

---

### User Story 2 - Preserve Decisions During Concurrent Triage (Priority: P1)

Two operators can review the same turn without one silently overwriting the
other's newer state or resolution.

**Why this priority**: Structured reasons make silent lost updates more harmful.
The product must tell an operator that the review changed before accepting a
decision based on stale information.

**Independent Test**: Load the same triage record in two clients, apply a
transition in the first, then attempt every transition from the stale second
client and verify conflict behavior, current-record recovery, and audit history.

**Acceptance Scenarios**:

1. **Given** two clients loaded the same triage version, **When** one client changes the record and the other submits its stale version, **Then** the stale write is rejected as a conflict and returns the current record.
2. **Given** a conflict in the dashboard, **When** the response arrives, **Then** the UI explains that another operator changed the review and offers to reload the current state without discarding the other operator's decision.
3. **Given** a terminal record, **When** an operator explicitly reopens it using the current version, **Then** the current resolution is cleared and the turn returns to active triage.
4. **Given** a turn is closed, reopened, and closed again, **When** its audit history is inspected, **Then** every transition and each terminal reason remains recorded in order even though only the latest state is current.

---

### User Story 3 - Add Or Open The Eval For A Turn In One Action (Priority: P1)

An operator or authorized API consumer can add an assistant turn to Eval with
one idempotent operation. Repeating the action opens or returns the same case
instead of creating duplicates or recapturing the source silently.

**Why this priority**: Verification should be a dependable action, not a
client-side scan and multi-request race. Stable identity is also the substrate
for showing Eval results back in Quality.

**Independent Test**: Invoke the operation once, repeatedly, and concurrently
for the same assistant message; invoke it for another message, a foreign
workspace message, a non-assistant message, and a deleted linked case; verify
identity, status codes, workspace isolation, and immutable snapshot behavior.

**Acceptance Scenarios**:

1. **Given** an assistant message with no linked Eval case, **When** an authorized caller adds it to Eval, **Then** one case and one immutable snapshot are created and returned.
2. **Given** an assistant message with a linked case, **When** the same operation is repeated, **Then** the existing case and its existing snapshot are returned without recapture.
3. **Given** concurrent first requests for one assistant message, **When** both complete, **Then** exactly one case is associated with the message and both callers receive it.
4. **Given** only an assistant message identifier, **When** the operation runs, **Then** the server derives and validates the conversation rather than requiring the caller to supply duplicate identity.
5. **Given** an existing link, **When** an authorized caller performs a read-only lookup, **Then** the linked case can be retrieved without creating or updating anything.
6. **Given** a linked case is intentionally deleted, **When** the operator later adds the source turn to Eval again, **Then** a new link and case may be created without reviving the deleted case.

---

### User Story 4 - See Whether A Fix Has Been Verified (Priority: P2)

An operator can see the linked Eval's current state from Quality and use a
passing result as evidence while deciding whether to resolve the review.

**Why this priority**: Creating an Eval case is not a learning loop unless the
result returns to the place where the original problem is triaged.

**Independent Test**: List Quality turns linked to pending, passing, failing,
error, recorded-only, and missing Eval cases; verify the API projection,
timestamped UI labels, links, refresh behavior, and absence semantics.

**Acceptance Scenarios**:

1. **Given** a Quality turn without a linked case, **When** it is displayed, **Then** the action is labeled Add to Eval and no verification result is implied.
2. **Given** a linked pending, passing, failing, or error case, **When** the turn is displayed, **Then** the operator sees a factual Eval status and can open that case directly.
3. **Given** a linked Eval whose latest scored run passed, **When** Quality displays the evidence, **Then** it says when the Eval passed and offers Review and resolve without selecting a reason or submitting a transition.
4. **Given** a historical pass followed by a newer failing or error result, **When** Quality reloads, **Then** the newest case and run state is shown rather than a stale passing label.
5. **Given** a Quality page with many turns, **When** verification is loaded, **Then** lookup work remains bounded by the page rather than issuing one request or query per row.

---

### User Story 5 - Learn From Closed Reviews (Priority: P2)

An operator can see a compact breakdown of current terminal reviews by reason,
filter the underlying turns by one or more reasons, and share or revisit that
filtered Quality URL.

**Why this priority**: Reasons earn their cost only when they reveal where
operators are investing—knowledge, retrieval, agent behavior, or platform
reliability—and let the operator inspect the evidence behind a count.

**Independent Test**: Close representative turns across both terminal states and
time ranges, reopen some, apply agent/channel/reason filters, click breakdown
entries, reload the resulting URL, and verify count/list parity.

**Acceptance Scenarios**:

1. **Given** terminal reviews in the selected 7- or 30-day window, **When** the operator views Quality, **Then** a compact breakdown shows resolved and not-actionable counts by reason without adding another permanent row of metric cards.
2. **Given** a reason in the breakdown, **When** the operator selects it, **Then** the queue is filtered to current terminal turns carrying that reason and the corresponding state.
3. **Given** reason and existing agent or channel filters, **When** stats and rows load, **Then** both use the same workspace, filter, terminal-state, and time-window semantics.
4. **Given** a closed turn is reopened, **When** breakdowns and filtered lists refresh, **Then** that turn is no longer counted as currently terminal.
5. **Given** reason filters encoded in the URL, **When** an authorized operator reloads or shares it, **Then** the same filter state is restored.

### Edge Cases

- The implicit open state has no persisted triage row or version yet.
- A stale acknowledge arrives after another operator resolved the turn.
- The same operator double-submits a terminal dialog.
- An operator attempts to attach resolution data to `open` or `acknowledged`.
- An operator attempts to close without a reason, supplies a reason from the
  wrong terminal-state vocabulary, uses `other` without a note, or exceeds the
  note length.
- A legacy client sends the old free-text `reason` input.
- A closed record created before structured reasons has no reason code.
- A record is reopened and closed more than once with different reasons.
- The operator who last changed the record has since been removed.
- The source assistant message, conversation, linked case, or current agent is
  deleted.
- The source message belongs to another workspace or is not assistant-authored.
- Concurrent Eval creation requests race before either sees the association.
- The linked case has no runs, an unscored recorded run, or a run still in
  progress.
- The latest Eval pass is old relative to later agent, knowledge, or platform
  changes; the UI must show its timestamp and must not claim a perpetual
  guarantee.
- Verification lookup partially fails while Quality turns themselves load.
- A reason has a zero count, `other` becomes common, or the selected window has
  no terminal reviews.
- Pagination, totals, stats, and reason filters are combined.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this specification is explicitly approved.
- Backend changes MUST follow TDD: failing tests before production
  implementation.
- Backend remains Node.js, frontend remains React, and PostgreSQL remains the
  system of record.
- Public API changes MUST use the code-first OpenAPI registry, regenerate
  checked-in OpenAPI artifacts, update TypeScript SDK and MCP generated types,
  and keep contract tests aligned.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit
  tests remain limited to API encoding, URL state, conflict-state transforms,
  and other non-visual logic.
- The dashboard MUST reuse existing dialog, table, filter, badge, typography,
  spacing, color, announcement, and focus-management conventions.
- Reason meaning MUST come from typed structured values, never English keyword
  matching over notes, questions, answers, prompts, or Eval output.
- Free-text resolution notes are customer data. They MUST be workspace-scoped,
  length-bounded, excluded from logs, metrics, traces, analytics, and audit
  metadata, and exposed only through existing Quality read permissions.
- Documentation MUST be updated for the operator workflow and public Quality and
  Eval APIs.

## Architecture Constraints *(mandatory)*

- **Quality Ownership Rule**: Quality owns current triage state, version,
  structured resolution, reason aggregation/filter semantics, and the neutral
  verification projection it exposes to consumers.
- **Eval Ownership Rule**: Eval owns immutable snapshots, cases, runs,
  per-message case association, idempotent creation/lookup, and interpretation
  of current case/run status.
- **Boundary Rule**: Quality MUST consume Eval state through a narrow batch read
  port. Quality MUST NOT join Eval tables directly, persist copied Eval status,
  create Eval cases itself, or infer verification from identifiers.
- **Association Rule**: One explicit message-to-Eval-case association MUST
  enforce at most one current linked case for an assistant message in a
  workspace. It MUST preserve database referential integrity and MUST NOT
  introduce a speculative polymorphic origin framework.
- **Snapshot Rule**: Repeating the convenience operation for an existing link
  MUST NOT recapture or mutate its immutable snapshot. Recapture remains an
  explicit, separate Eval concern.
- **Concurrency Rule**: The current triage record has an explicit monotonic
  version. Every transition compares the caller's expected version and rejects
  stale writes; timestamps are display metadata, not the concurrency token.
- **History Rule**: The current triage row remains the fast read model. Durable
  audit events record each accepted transition and terminal reason; audit
  history is not reconstructed from the mutable current row.
- **Encapsulation Rule**: Quality query orchestration, Eval routes, and the
  Quality page component MUST remain responsibility-limited. Focused validation,
  transition, verification-enrichment, association, and presentation seams MUST
  be introduced rather than expanding the largest existing files.
- **Composition Rule**: Application composition owns wiring the Eval batch port
  into Quality; neither domain may reach into application composition.
- **Dependency Rule**: UI and public clients depend on code-first contracts;
  transport depends on module ports; Quality depends only on a neutral Eval
  verification port; Eval does not depend on Quality.
- **Anti-Goals**: Do not auto-resolve a review, auto-select a reason, treat
  `added_to_eval` as a reason, copy Eval state into triage storage, scan all Eval
  cases client-side, add keyboard shortcuts, add bulk triage, or create a
  generic remediation framework.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Terminal triage MUST use a structured resolution with one typed
  reason and an optional note of at most 500 characters.
- **FR-002**: Resolved reasons MUST be `knowledge_gap`, `retrieval_issue`,
  `agent_behavior`, `platform_bug`, or `other`.
- **FR-003**: Not-actionable reasons MUST be `expected_behavior`,
  `out_of_scope`, `invalid_feedback`, or `other`.
- **FR-004**: The `other` reason MUST require a non-blank note. All other notes
  remain optional.
- **FR-005**: `resolved` and `dismissed` writes MUST include a resolution and
  MUST accept only the reason vocabulary valid for that state.
- **FR-006**: `open` and `acknowledged` writes MUST reject resolution data.
- **FR-007**: Every Quality triage representation MUST expose a monotonic integer
  version. The implicit initial open record MUST have a stable initial version
  that callers can use.
- **FR-008**: Every transition request MUST include the version the caller
  observed. A mismatched version MUST return `409 Conflict` with the current
  triage record and MUST NOT modify state, resolution, or audit history.
- **FR-009**: An explicit reopen to `open` using the current version MUST clear
  the current resolution and increment the version.
- **FR-010**: Every accepted transition MUST record an audit event containing
  workspace, assistant message, prior state, next state, resulting version,
  actor, structured reason when terminal, and linked Eval case identifier when
  present.
- **FR-011**: Audit, logs, metrics, traces, and analytics MUST NOT contain the
  free-text resolution note.
- **FR-012**: Existing legacy free-text `reason` input MUST remain accepted as a
  deprecated compatibility path in this feature. It MUST NOT be silently
  interpreted as a structured reason, and its eventual removal MUST require a
  separately documented versioned breaking change.
- **FR-013**: Historical terminal rows without a structured reason MUST remain
  readable as unspecified history; the feature MUST NOT fabricate a reason from
  legacy free text.
- **FR-014**: Quality and Needs Attention MUST use the same reason labels,
  validation, close-review dialog, conflict behavior, and terminal success
  semantics.
- **FR-015**: The close-review dialog MUST make the selected terminal action
  clear, expose only valid reasons, support keyboard and screen-reader use,
  prevent double submission, and preserve the operator's optional note when a
  recoverable request error occurs.
- **FR-016**: A successful terminal action from an active queue MUST remove the
  item, announce the result through an accessible live region, and restore focus
  to the next logical target.
- **FR-017**: A conflict MUST leave the other operator's current record intact
  and present the current state plus an explicit reload/review action.
- **FR-018**: Eval MUST expose an idempotent operation addressed by assistant
  message identifier that finds or creates the one associated case.
- **FR-019**: The Eval convenience operation MUST derive the conversation and
  source context server-side, validate assistant authorship and workspace
  ownership, and use the server-owned default case name.
- **FR-020**: First creation MUST return the new case, its immutable snapshot,
  and an explicit created indicator; subsequent calls MUST return the existing
  case and snapshot with a not-created indicator.
- **FR-021**: Concurrent first calls for one workspace/message MUST converge on
  one association and one case without surfacing an internal uniqueness error.
- **FR-022**: Repeating the convenience operation for an existing association
  MUST NOT capture a new snapshot, rename the case, reset assertions, reset
  status, or otherwise mutate it.
- **FR-023**: Eval MUST provide a read-only lookup for an assistant message that
  returns the associated case or the existing not-found response without
  creating data.
- **FR-024**: Deleting a linked case MUST remove its message association so a
  future explicit add can create a new case. Deleting a source message MUST not
  violate existing Eval snapshot retention behavior.
- **FR-025**: Quality turn responses MUST expose `verification` as either null or
  a lightweight object containing case identifier, case status, latest run
  status, and latest run timestamp.
- **FR-026**: Quality MUST obtain verification for a page of turns through one
  batch-capable Eval port whose work does not grow into one request or query per
  row.
- **FR-027**: A missing association MUST produce `verification: null`. A
  temporarily unavailable verification source MUST not fabricate null as a
  definitive “not in Eval” result and MUST use the dashboard's existing degraded
  source treatment.
- **FR-028**: The dashboard MUST label an unlinked action Add to Eval and a
  linked action Open Eval with its current pending, passing, failing, or error
  status.
- **FR-029**: Passing evidence MUST include the latest run time in absolute or
  relative form and MUST not be presented as an untimestamped permanent
  guarantee.
- **FR-030**: A passing Eval MAY offer Review and resolve, but MUST NOT open a
  preselected reason, submit a transition, or otherwise equate passing with a
  root cause.
- **FR-031**: Quality list filtering MUST accept one or more structured
  resolution reasons and combine them with terminal state and all existing
  filters using explicit, documented semantics.
- **FR-032**: Reason filter state MUST be normalized into the dashboard URL,
  restored on reload, shown in active-filter controls, and individually
  removable.
- **FR-033**: Quality stats MUST include a resolution breakdown for current
  terminal records whose latest terminal transition occurred inside the selected
  7- or 30-day window, split by terminal state and structured reason.
- **FR-034**: Resolution breakdowns MUST honor the same workspace, agent, and
  channel filters as the associated Quality view. Reopened records and legacy
  unspecified reasons MUST be reported distinctly rather than assigned a
  fabricated typed reason.
- **FR-035**: Selecting a breakdown reason MUST navigate to the underlying
  current terminal turns with the matching state and reason filters.
- **FR-036**: Public request, success, null, deprecation, conflict, validation,
  authorization, and not-found behavior MUST be documented in code-first
  OpenAPI.
- **FR-037**: Generated OpenAPI artifacts, TypeScript SDK types, and MCP OpenAPI
  types MUST match the runtime Quality and Eval contracts.
- **FR-038**: Operator documentation MUST explain reason selection, reopen,
  concurrent-change recovery, Add/Open Eval, timestamped Eval evidence, and the
  clickable reason breakdown. API documentation MUST explain idempotency,
  version conflicts, and legacy compatibility.
- **FR-039**: The feature MUST NOT change document-worker dispatch, AMQP
  payloads, retry semantics, or queue contract tests because no worker or queue
  contract is involved.
- **FR-040**: Accepted transitions and Eval association creation/finding MUST
  produce structured operational evidence sufficient to diagnose conflicts and
  failures without recording notes, prompts, answers, document content,
  retrieved chunks, credentials, cookies, tokens, or connection strings.
- **FR-041**: No new high-cardinality metric is required. Resolution breakdowns
  are the operator-facing aggregate; structured logs and audit events cover the
  new state-changing failure paths.

### UI Tasks

- Replace direct terminal state changes in Quality with the shared close-review
  dialog while keeping active-state transitions lightweight.
- Use the same dialog from the negative-feedback Needs Attention drawer.
- Add action-specific reason choices, optional note, `other` validation,
  pending/error/conflict states, success announcement, and focus restoration.
- Show existing structured resolution details when browsing closed turns.
- Replace the ambiguous Open in Eval behavior with honest Add to Eval and Open
  Eval status labels.
- Show timestamped Eval evidence and a non-automatic Review and resolve action.
- Add structured reason controls to the existing filter dialog and applied
  filter treatment.
- Add one compact clickable resolution breakdown within the current Quality
  information hierarchy without another permanent metric-card row.
- Cover empty, loading, degraded verification, conflict, deleted link, legacy
  unspecified, and no-resolution-data states.

### Key Entities

- **Quality Triage Record**: Current workspace-scoped review state for one
  assistant message, including monotonic version, optional current structured
  resolution, actor, and update time.
- **Structured Resolution**: Terminal classification containing one
  state-compatible reason and an optional bounded note.
- **Triage Transition Audit**: Immutable record of an accepted state transition,
  version, actor, structured reason, and linked Eval identifier, excluding note
  content.
- **Eval Message Association**: Referentially enforced one-to-one link from a
  workspace assistant message to its current Eval case. It is separate from the
  immutable snapshot.
- **Quality Verification Projection**: Read-only case and latest-run status
  exposed by Quality through a narrow Eval-owned batch port.
- **Resolution Breakdown**: Windowed counts of current terminal reviews grouped
  by state and structured reason.

### Assumptions And Dependencies

- The existing Quality permissions remain sufficient:
  `workspace.quality.read` for reads and `workspace.quality.manage` for
  transitions. Existing Eval query permissions protect case lookup/creation.
- Assistant message identifiers are unique and workspace ownership can be
  resolved server-side.
- Eval snapshots remain immutable and intentionally recapturable through
  explicit existing Eval workflows.
- The Quality page's current 7-/30-day range and agent/channel filters provide
  the scope for resolution breakdowns.
- Legacy free-text reasons are sparse and cannot be classified safely without
  multilingual heuristics, so they remain unspecified.
- `other` usage is visible in the breakdown and can inform a later taxonomy
  revision; this feature does not automate taxonomy changes.

### Out Of Scope

- Automatic remediation, automatic resolution, or automatic reason selection.
- Treating Eval creation or a passing Eval as proof of a particular root cause.
- Automatic Eval assertion generation or snapshot recapture.
- Content-gap clustering or ranked missing-knowledge reports (#939).
- Needs Attention pagination, assignment, bulk triage, or bulk dismissal (#941).
- Keyboard shortcuts for triage.
- A generic polymorphic origin or remediation-link framework.
- Changing retrieval, answer generation, quality-signal meaning, or existing
  quality-rate denominators.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In usability testing, an operator can close a review with a
  structured reason in no more than 10 seconds and without leaving Quality or
  Needs Attention.
- **SC-002**: Every newly completed terminal review contains a valid structured
  reason; `other` reviews contain a non-blank note.
- **SC-003**: In concurrent-transition tests, zero stale writes overwrite a
  newer accepted decision, and every rejected caller receives the current
  record.
- **SC-004**: Repeated and concurrent Add to Eval actions for one assistant
  message produce exactly one current linked case and never recapture its
  snapshot implicitly.
- **SC-005**: Opening an existing linked Eval from Quality requires no
  workspace-wide case scan and no per-case snapshot fetches.
- **SC-006**: A Quality page containing 100 turns obtains all linked
  verification summaries with a bounded number of server operations independent
  of the number of linked rows and presents the page within 2 seconds under the
  standard local performance fixture.
- **SC-007**: For every reason and supported filter combination, the clickable
  breakdown count equals the number of current terminal turns returned by the
  corresponding filtered API query.
- **SC-008**: Operators can distinguish no linked Eval, pending, passing,
  failing, and error states without opening the case; passing evidence always
  includes when it occurred.
- **SC-009**: Playwright verifies close, conflict, focus, announcement, Add/Open
  Eval, timestamped evidence, filtering, URL restoration, and breakdown
  navigation on both applicable dashboard surfaces.
- **SC-010**: OpenAPI, generated SDK/MCP types, operator documentation, and
  runtime behavior agree on the new success, null, validation, deprecation,
  authorization, conflict, and idempotency contracts.
