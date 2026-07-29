# Feature Specification: Quality Grounding Diagnostics

**Feature Branch**: `873-quality-grounding-diagnostics`
**Created**: 2026-07-29
**Status**: Approved for implementation
**Input**: User description: "Implement GitHub issue #938. Choose the best operator experience in both the Quality UI and API, persist claim-level grounding diagnostics, and proceed."

## Existing Behavior And Feature Delta

The turn path already computes a `GroundingSummary`. It copies the verdict and
diagnostics into the assistant message's `metadata_json` and into `chat.answer`
or `chat.suspended` audit-event metadata. That data is useful for eval and trace
reconstruction, but it is not a queryable Quality read model:

- `messages` has no first-class grounding verdict or count columns;
- `GET /api/v1/quality/turns` returns only coarse skill outcome/status data;
- Quality filters cannot select verdicts, unsourced claims, or invalid sources;
- the dashboard can label a turn degraded but cannot show the claim breakdown;
- querying historical detail would require request-time JSON parsing or an audit
  event scan.

This feature adds the missing durable and operator-facing layer:

1. dedicated, constrained grounding verdict/count columns on `messages`;
2. safe backfill from both lifecycle event types that currently carry complete
   diagnostics;
3. a typed Quality API object and server-side filters over those columns;
4. compact dashboard evidence details and shareable URL filters;
5. synchronized OpenAPI, SDK, MCP, test, and documentation contracts.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Understand Why An Answer Needs Review (Priority: P1)

A workspace operator reviewing the Quality queue can see whether a retrieval
answer was fully grounded, contained unsourced claims, or cited invalid sources
without opening the conversation or inspecting an internal trace.

**Why this priority**: A degraded label identifies a problem but does not tell the
operator whether to improve content, investigate retrieval, or fix citation
quality.

**Independent Test**: Populate the Quality queue with fully grounded, partially
unsourced, invalid-source, no-support, non-retrieval, and unavailable-history
turns, then verify each row communicates only the evidence known for that turn.

**Acceptance Scenarios**:

1. **Given** a retrieval answer with all claims sourced, **When** an operator views its Quality row, **Then** the row shows the sourced claim count without warning about unsourced or invalid sources.
2. **Given** a retrieval answer with unsourced claims, **When** an operator views its Quality row, **Then** the row shows the sourced total and the non-zero unsourced count.
3. **Given** a retrieval answer with invalid source references, **When** an operator views its Quality row, **Then** the row calls out the non-zero invalid-source count with stronger warning emphasis than a healthy count.
4. **Given** a no-support retrieval result, **When** an operator views its Quality row, **Then** the row says that there were no supported claims rather than presenting a misleading zero-percent ratio.
5. **Given** a non-retrieval turn or a historical turn without complete diagnostics, **When** an operator views its Quality row, **Then** the UI does not invent zero counts or imply that evidence was evaluated.

---

### User Story 2 - Isolate A Specific Grounding Failure (Priority: P1)

A workspace operator can filter the Quality queue to degraded verdicts, answers
with unsourced claims, or answers with invalid source references, combine those
choices with existing filters, and share or revisit the resulting URL.

**Why this priority**: Grounding problems require different remediation. An
operator should be able to turn the queue into a focused worklist rather than
scan every degraded answer manually.

**Independent Test**: Apply each evidence filter alone and in combination with
agent, channel, signal, feedback, triage, and latency filters; reload the URL and
verify the same matching rows remain.

**Acceptance Scenarios**:

1. **Given** turns with several grounding verdicts, **When** an operator selects one or more verdicts, **Then** the queue contains turns matching any selected verdict.
2. **Given** turns with and without unsourced claims, **When** the operator enables the unsourced-claims filter, **Then** only turns with a known positive unsourced count are listed.
3. **Given** turns with and without invalid source references, **When** the operator enables the invalid-sources filter, **Then** only turns with a known positive invalid-source count are listed.
4. **Given** an evidence filter and an existing Quality filter, **When** both are applied, **Then** a turn must satisfy both filter groups to appear.
5. **Given** evidence filters in the dashboard URL, **When** the page is reloaded or the URL is shared with another authorized operator, **Then** the same filter state is restored.

---

### User Story 3 - Query Grounding Diagnostics Through The API (Priority: P1)

An authorized API consumer can read the same structured grounding diagnostic the
operator sees and can query the Quality endpoint by verdict, unsourced claims, or
invalid source references without parsing answer text or audit-event JSON.

**Why this priority**: The dashboard and external operator tooling need one
stable, typed source of truth. Reconstructing quality from text or internal event
payloads would be brittle and multilingual-hostile.

**Independent Test**: Request Quality turns with and without each new query
parameter and verify the response shape, null semantics, filter composition,
validation errors, and generated client types.

**Acceptance Scenarios**:

1. **Given** a turn with complete diagnostics, **When** an authorized consumer lists Quality turns, **Then** the response contains one structured grounding object with verdict and non-negative claim counts.
2. **Given** a turn without complete diagnostics, **When** an authorized consumer lists Quality turns, **Then** the response contains `grounding: null`.
3. **Given** multiple verdict values as repeated or comma-separated parameters, **When** the consumer lists turns, **Then** matching verdicts are OR-ed and duplicate turns are not returned.
4. **Given** invalid verdict or boolean filter values, **When** the consumer lists turns, **Then** the endpoint rejects the request using the existing invalid-query error contract.
5. **Given** `hasUnsourcedClaims=false` or `hasInvalidSources=false`, **When** the consumer lists turns, **Then** only turns with a complete diagnostic and a zero value for that count match; unknown diagnostics do not match.

---

### User Story 4 - Retain Useful Historical Evidence Safely (Priority: P2)

An operator sees recoverable grounding diagnostics for historical turns after
upgrade, while malformed, partial, or unrecognized historical data remains
explicitly unavailable.

**Why this priority**: The Quality queue is all-time. A new-turn-only feature
would leave the current backlog largely unexplained, while an unsafe backfill
could turn missing information into false precision.

**Independent Test**: Migrate a dataset containing valid complete
`chat.answer` and `chat.suspended` diagnostics, partial diagnostics, malformed
values, unknown verdicts, and multiple lifecycle events for one message; verify
only the latest lifecycle event is considered and it is stored only when its
diagnostic is complete and valid.

**Acceptance Scenarios**:

1. **Given** a historical assistant turn whose latest matching `chat.answer` or `chat.suspended` event has a recognized verdict and complete valid counts, **When** the migration runs, **Then** those values are stored on the turn.
2. **Given** partial, negative, non-integer, internally inconsistent, or unrecognized historical diagnostics, **When** the migration runs, **Then** every new grounding field for that turn remains null.
3. **Given** several `chat.answer` and/or `chat.suspended` events for one assistant turn, **When** the migration runs, **Then** the latest event across both types by creation and identifier order is the only source considered.
4. **Given** a migration retry, **When** already populated turns are encountered, **Then** stored diagnostics are not overwritten.

### Edge Cases

- A grounded answer has zero claims.
- Sourced and unsourced claim counts do not add up to the total claim count in
  historical data.
- Invalid-source count is non-zero even when all claims are otherwise sourced.
- A degraded verdict has zero unsourced and zero invalid sources because another
  grounding check caused degradation.
- A retrieval turn completes through a suspended or resumed workflow.
- A `chat.suspended` event is followed by a later `chat.answer` event, or the
  reverse, for the same assistant message.
- A message is persisted without any grounding summary.
- The newest matching lifecycle event is partial while an older event is
  complete.
- Boolean filters are supplied as `false`, repeated, or combined with verdicts.
- Pagination and totals are requested with evidence filters.
- A turn matches more than one selected verdict or quality signal.
- Existing Quality stats and backlog counts are computed while grounding detail
  filters are in use.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this specification is explicitly approved.
- Backend changes MUST follow TDD: failing tests before production implementation.
- Backend remains Node.js, frontend remains React, and PostgreSQL remains the
  system of record.
- Public API changes MUST be code-first, regenerate checked-in OpenAPI artifacts,
  update the TypeScript SDK, update generated MCP API types, and keep contract
  tests aligned.
- The API and UI MUST use structured grounding metadata and MUST NOT infer product
  meaning from English keywords, answer text, or citation formatting.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit
  tests remain limited to API encoding, URL state, and other non-visual logic.
- The Quality UI MUST reuse existing dashboard table, filter, badge, color,
  typography, spacing, and accessibility conventions.
- Grounding diagnostics MUST NOT expose prompts, answer bodies beyond existing
  previews, retrieved chunks, document content, provider payloads, credentials,
  cookies, or connection strings.
- Documentation MUST be updated for the operator workflow and public Quality API.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Chat answer presentation owns computing the structured
  grounding summary; chat turn persistence owns storing that already-computed
  snapshot; Quality owns read and filter semantics; HTTP owns validation and
  transport documentation; the dashboard owns presentation only.
- **Read-Only Quality Rule**: Quality diagnostics and filters MUST NOT feed back
  into retrieval, routing, answer composition, or turn behavior. Triage remains
  the Quality module's only write.
- **Snapshot Rule**: The persisted diagnostic describes the answer at turn
  creation time and MUST live in dedicated scalar columns on the `messages`
  record it describes. Later document, retrieval-setting, or agent changes MUST
  NOT rewrite it.
- **Completeness Rule**: A diagnostic is available only when verdict and every
  claim count are present and valid. The public representation MUST be a complete
  object or `null`, never a partial object and never fabricated zeroes.
- **Encapsulation Rule**: `chatTurnLifecycle.ts` remains lifecycle orchestration,
  `quality/service.ts` remains readable top-to-bottom query orchestration, HTTP
  routes remain transport-only, and `quality-view.tsx` MUST NOT acquire
  grounding classification rules.
- **New Seams Required**: Use one shared grounding diagnostic value shape at the
  chat persistence boundary and one focused Quality mapping/predicate seam where
  needed; do not duplicate structurally equivalent count types across chat,
  persistence, and Quality without an explicit adapter.
- **Dependency Rule**: UI depends on the public Quality contract; HTTP depends on
  Quality ports; Quality reads the persisted message snapshot; chat passes its
  computed summary toward persistence. No reverse dependency is allowed.
- **Historical Data Rule**: Historical audit JSON may be read once by the
  migration only, using `chat.answer` and `chat.suspended` as the complete set of
  eligible lifecycle event types. Request-time Quality reads MUST NOT scan audit
  events, inspect `messages.metadata_json`, or parse JSON to recover grounding
  data.
- **Anti-Goals**: Do not recompute grounding from stored answer text. Do not add
  a new provider call, runtime prompt, worker, or queue. Do not add a separate
  Quality table when the diagnostic belongs to the assistant message. Do not add
  a new dashboard column when the existing Outcome cell can carry the compact
  explanation. Do not change signal predicates or Quality rate denominators.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `messages` MUST have dedicated nullable scalar columns
  `grounding_verdict`, `grounding_claim_count`,
  `grounding_sourced_claim_count`, `grounding_unsourced_claim_count`, and
  `grounding_invalid_source_count`. Each newly persisted assistant turn with a
  computed grounding summary MUST write all five columns as one complete
  diagnostic snapshot. Existing JSON metadata MUST NOT satisfy this requirement.
- **FR-002**: A newly persisted assistant turn without a computed grounding
  summary MUST leave all five dedicated grounding columns null.
- **FR-003**: Database constraints MUST require the five dedicated grounding
  columns to be either all null or all present. Present counts MUST be
  non-negative integers, and sourced plus unsourced claims MUST equal total
  claims.
- **FR-004**: The supported verdict vocabulary MUST remain `grounded`,
  `degraded`, and `no_support`.
- **FR-005**: The Quality turn response MUST include `grounding`, which is either
  `null` or an object containing `verdict`, `claimCount`,
  `sourcedClaimCount`, `unsourcedClaimCount`, and `invalidSourceCount`.
- **FR-006**: The Quality API MUST accept one or more `groundingVerdict` values as
  comma-separated or repeated query parameters.
- **FR-007**: The Quality API MUST accept `hasUnsourcedClaims` and
  `hasInvalidSources` boolean query parameters.
- **FR-008**: Multiple grounding verdict values MUST use OR semantics; grounding
  filter groups MUST combine with each other and all existing filters using AND
  semantics.
- **FR-009**: A `true` claim-presence filter MUST match only complete diagnostics
  whose corresponding count is greater than zero.
- **FR-010**: A `false` claim-presence filter MUST match only complete diagnostics
  whose corresponding count is zero; null diagnostics MUST not match.
- **FR-011**: Grounding filters MUST preserve existing pagination, totals,
  ordering, workspace isolation, authorization, and duplicate-elimination
  behavior.
- **FR-012**: Invalid grounding query values MUST use the existing invalid Quality
  query response behavior.
- **FR-013**: The Quality dashboard MUST show a compact grounding breakdown
  beneath the existing Outcome badge rather than add another table column.
- **FR-014**: A complete diagnostic with claims MUST show sourced claims as
  `sourcedClaimCount of claimCount claims sourced`.
- **FR-015**: The dashboard MUST call out non-zero unsourced claim and invalid
  source counts separately and MUST not display zero-value warnings.
- **FR-016**: A `no_support` diagnostic with zero claims MUST use plain-language
  no-support copy rather than a numeric ratio.
- **FR-017**: Null grounding diagnostics MUST not render a numeric breakdown or
  unavailable value that could be mistaken for a quality failure.
- **FR-018**: The dashboard filter dialog MUST include an Evidence section with a
  multi-select grounding-verdict filter and positive boolean filters for
  unsourced claims and invalid sources.
- **FR-019**: Dashboard evidence filter state MUST be represented in normalized,
  shareable URL state and restored on reload.
- **FR-020**: Active evidence filters MUST appear in the existing applied-filter
  controls and be individually removable.
- **FR-021**: Selecting a top-level signal preset MUST clear evidence filters in
  the same way it clears other detailed queue filters.
- **FR-022**: A one-time migration MUST backfill historical assistant turns from
  the latest matching event across `chat.answer` and `chat.suspended`, ordered by
  event creation time and identifier descending. It MUST write the dedicated
  message columns only when verdict and every count on that latest event are
  recognized, non-negative integers, and internally consistent; it MUST NOT fall
  back to an older event when the latest event is incomplete.
- **FR-023**: The historical migration MUST leave all diagnostic fields null for
  partial, malformed, negative, non-integer, inconsistent, or unknown data.
- **FR-024**: The historical migration MUST not overwrite an already stored
  diagnostic.
- **FR-025**: Existing Quality signal classification, grounded-rate calculation,
  health windows, and backlog counts MUST remain unchanged.
- **FR-026**: Existing Quality read authorization MUST protect the new fields and
  filters; no new permission or broader access MUST be introduced.
- **FR-027**: Code-first OpenAPI MUST document the grounding object, null
  semantics, supported verdicts, and query filter behavior.
- **FR-028**: Generated backend OpenAPI artifacts, TypeScript SDK types, and MCP
  OpenAPI types MUST agree with the runtime contract.
- **FR-029**: Operator documentation MUST explain how to read and filter the
  evidence breakdown, and API documentation MUST include the new response field
  and query parameters.
- **FR-030**: The feature MUST NOT change document-worker dispatch, AMQP payloads,
  retry semantics, or queue contract tests because no worker or queue contract is
  involved.
- **FR-031**: No new runtime log, metric, telemetry event, audit event, or span is
  required because this feature extends an existing atomic turn write and
  read-only query path without adding a provider call, job, retry, fallback, or
  new failure mode.

### UI Tasks

- Add the grounding breakdown to the existing Outcome cell for Quality rows with
  a complete diagnostic.
- Use the existing dashboard warning and muted styles to distinguish healthy,
  unsourced, and invalid-source information without relying on color alone.
- Add an Evidence section to the existing filter dialog.
- Add active-filter pills, clear behavior, URL parsing, and URL serialization for
  the three evidence filters.
- Cover populated, no-support, null, empty-result, reload, and combined-filter
  states through the existing Quality experience.

### Key Entities

- **Grounding Diagnostic**: Immutable per-answer snapshot containing one verdict
  and four non-negative claim/source counts. It is complete or absent.
- **Quality Turn**: Existing operator read model for one assistant message,
  extended with an optional grounding diagnostic.
- **Grounding Filter**: Verdict selection or presence predicate applied to the
  existing Quality turn population.

### Assumptions And Dependencies

- `GroundingSummary` remains computed before assistant-turn persistence.
- Historical `chat.answer` and `chat.suspended` audit events may contain
  `groundingVerdict` and `groundingDiagnostics`; absence is expected and safe.
- The current dashboard Outcome cell has enough vertical space for a compact
  second line, avoiding a ninth table column.
- No index is required initially because evidence predicates are secondary
  filters over the existing workspace-scoped assistant-turn population. This
  assumption must be reviewed against the generated query and focused tests.
- No runtime prompt or user-facing assistant/chat response changes are involved.
- GitHub issue #946 may change future outcome classification, but this feature
  reads the independently computed grounding summary and does not depend on
  #946.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For 100% of new turns that reach persistence with a grounding
  summary, the Quality API returns a complete grounding object with the same
  verdict and counts.
- **SC-002**: For 100% of turns without a complete valid diagnostic, the Quality
  API returns `grounding: null`; no partial objects or fabricated zeroes appear.
- **SC-003**: Each grounding filter returns exactly the matching rows and total,
  both alone and when combined with every existing filter family covered by the
  Quality integration suite.
- **SC-004**: An operator can distinguish fully sourced, unsourced, invalid-source,
  and no-support rows from the Quality table without opening a conversation.
- **SC-005**: Reloading or sharing a URL with evidence filters restores all
  selected evidence filters and produces the same result set for an authorized
  operator.
- **SC-006**: Every historical row whose latest matching `chat.answer` or
  `chat.suspended` event has a complete valid diagnostic is backfilled, while
  every tested malformed or incomplete latest-event variant remains wholly null.
- **SC-007**: Existing grounded rates, signal counts, and active backlog counts
  remain byte-for-byte equivalent for the same turn population before and after
  the feature.
- **SC-008**: Runtime OpenAPI output, generated SDK types, generated MCP types,
  and Quality API responses pass contract validation with no drift.
