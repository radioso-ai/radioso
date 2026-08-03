# Feature Specification: Audience Pulse

**Feature Branch**: find-next-good-issue-v1
**Created**: 2026-08-02
**Rewritten**: 2026-08-03
**Status**: Approved — 2026-08-03
**Source**: GitHub issue #939 and the decision to replace continuous Content
Planning with a small, operator-invoked conversation-insights experience.

## Goal

Give a workspace operator a fast, evidence-backed answer to three questions:

1. What are visitors talking about lately?
2. Which of those topics had no or only partial grounded support in the analyzed
   conversations?
3. What content should we consider adding, and how can I start a document for it?

The first release is an on-demand, read-only Audience Pulse. An operator requests
an analysis of the last 30 days; the server supplies bounded, workspace-scoped
conversation evidence and persisted grounding signals to an analysis agent; the
dashboard renders its validated structured report, content-gap signals, and
recommendations.

This is deliberately an 80% solution. It makes useful qualitative decisions from
recent conversation evidence without building a continuous topic-projection, a new
corpus-coverage system, or a new content-management system.

## Product Decision

Audience Pulse replaces the proposed Continuous Content Planning v1.

- It is an operator-only dashboard analysis, not a visitor-facing assistant skill.
- It runs only when an operator selects Analyze last 30 days.
- Analysis is advisory and read-only. It never changes documents, retrieval settings,
  assistant behavior, or conversations. A dashboard action may hand an operator into
  the existing document composer, but it never creates, saves, or publishes a document.
- SQL supplies all exact volume and date metrics. The model labels, groups, and
  synthesizes evidence; it is never the source of a displayed census count.
- A completed analysis is saved as the one current snapshot for its workspace. Opening
  the page reads that snapshot; only an explicit Analyze or Refresh action calls the
  model and atomically replaces it.
- The snapshot stores only the validated, operator-visible report structure and opaque
  source references. It does not retain raw excerpts, prompts, or provider transcripts,
  and it has no history or audit role.
- Its internal read result is tool-shaped: a small, JSON-serializable, Zod-backed
  request/result contract with an explicit read operation. The dashboard is its first
  adapter; v1 does not register a public MCP tool or a normal turn skill.
- Analysis uses workspace-scoped structured inference. It must not participate in
  customer turn routing or require the generic tool-calling agent runtime.

## Approved Readability Refinement — 2026-08-03

The saved report is a decision surface, not a diagnostic dump. This refinement supersedes
any earlier presentation wording that makes a volume table, a separate observed-gap list,
or repeated sample caveats prominent.

- The dashboard leads with content opportunities; Topics provide the supporting evidence.
  A topic’s badge carries its recurring uncovered signal, so there is no redundant
  Observed content gaps section.
- The completed report leads with **Last 30 days** and a supporting date range. Coverage
  is one plain sentence, such as “Read 72 of 104 questions”; a sampling caveat appears
  once at the bottom.
- Chat owns exact weekly aggregation and returns every UTC week intersecting the analysis
  interval, including zero-volume weeks. The dashboard may keep that data behind topic
  disclosure and does not make a volume table a primary surface.
- The server derives display occurrences from normalized identical question text at
  hydration time. A theme returns both raw sampled occurrences and a distinct-question
  count; one authorized representative evidence anchor carries `occurrenceCount`. The
  UI renders one question with “asked N×”, never a padded sequence of matching message IDs.
- The server also returns the number of sampled questions not assigned to a reliable topic.
  When that is a majority, the UI may make it prominent as “not grouped into a topic”; it
  must not call the source questions irrelevant or malformed.
- Topic cards are collapsed by default. Their visible state is title, one short
  description, question/occurrence count, and an optional uncovered badge. Grounding
  details and question evidence are disclosed with an accessible control. A grounding
  strip is omitted when it communicates only one uniform outcome.
- Operator copy uses plain language. It never exposes `contentGapEligible`, provider
  internals, corpus-proof claims, or model/process diagnostics. Model-authored summary,
  description, rationale, and caveat fields are limited to one direct plain-language
  sentence with compact schema bounds.

## Existing Behavior And Feature Delta

Radioso already stores workspace-scoped conversation history, per-answer grounding
diagnostics where an assistant answer was evaluated, and operator conversation and
Quality review surfaces. It does not currently summarize recent visitor interests
across conversations or recommend content opportunities.

Audience Pulse adds one bounded analysis request, one compact dashboard view, and a
safe handoff to the existing document composer. It does not record each message as an
observation, calculate semantic embeddings, retain topic membership, or continuously
update a report after a visitor turn.

## User Scenarios & Testing

### User Story 1 - Request a recent audience pulse (Priority: P1)

An operator opens Audience Pulse and requests an analysis of the last 30 days.

**Why this priority**: A useful report must be intentional, current, and cheap enough
to understand before the product invests in durable analytics.

**Independent test**: Seed eligible conversations across the preceding 30 days, invoke
the analysis once, and verify the response's date range, deterministic volume metrics,
sample-coverage disclosure, and bounded structured result.

**Acceptance scenarios**:

1. **Given** an authorized operator and eligible visitor traffic, **When** they choose
   Analyze last 30 days, **Then** the dashboard receives and saves one report for that
   workspace and fixed period without changing any conversation or document.
2. **Given** no eligible visitor traffic, **When** the operator requests a pulse,
   **Then** the page explains that more visitor conversations are needed and no model
   request is made.
3. **Given** a workspace larger than the configured analysis bound, **When** a pulse
   runs, **Then** the result identifies the analyzed sample and does not present
   sample-derived theme counts as a complete workspace census.
4. **Given** an analysis is in flight, **When** the operator remains on the page,
   **Then** the page exposes a clear loading state and prevents accidental duplicate
   submissions from that view.
5. **Given** a saved report exists, **When** the operator opens or revisits Audience
   Pulse, **Then** the page loads that report without making a model request and offers
   an explicit Refresh action.
6. **Given** another operator has already started a refresh for the workspace, **When**
   this operator requests one, **Then** the page receives a retry-later busy state and
   does not label it a provider failure or start another provider call.

---

### User Story 2 - See what people are talking about (Priority: P1)

An operator can understand recent conversation volume and the recurring themes in the
analyzed evidence without mistaking model inference for exact measurement.

**Why this priority**: The original product insight is visibility into visitor
interests, not durable clustering for its own sake.

**Independent test**: Use a fixture with known weekly message/conversation totals,
distinct themes, typed assistant outcomes, and persisted `grounded`, `degraded`,
`no_support`, and unavailable grounding states. Verify exact totals, theme grounding
signals, and content-gap eligibility come from the server, each theme has only
authorized source evidence, and sample-based intensity is explicitly labeled.

**Acceptance scenarios**:

1. **Given** a completed report, **When** the operator views the overview, **Then**
   they see exact eligible visitor-question and conversation volume by week for the
   30-day period.
2. **Given** the analysis agent groups evidence into themes, **When** the operator
   views a theme, **Then** they see a short synthesized description, representative
   questions, and a sample-based weekly pulse derived by the server from the linked
   evidence.
3. **Given** a theme is derived from a capped sample, **When** it is rendered, **Then**
   its counts and heat treatment are described as analyzed-sample signals rather than
   total demand.
4. **Given** an item does not fit a reliable theme, **When** the report is rendered,
   **Then** it may be omitted or shown as an uncategorized sample; the system must not
   force it into a misleading theme.
5. **Given** a theme contains sampled visitor questions with linked assistant answers,
   **When** the report renders, **Then** it shows server-derived counts of grounded,
   partially grounded, unsupported, and unknown answer signals, plus a separate
   server-owned content-gap eligibility count, rather than asking the model to decide
   whether content exists.
6. **Given** an item has no persisted grounding diagnostic, **When** it is grouped into
   a theme, **Then** it is shown as unknown and must not be presented as a content gap.
7. **Given** an answer has `no_support` because it was out of scope or generation was
   unavailable, **When** its visitor question is grouped into a theme, **Then** it
   remains an observed discussion signal but is not eligible for the content-gap
   section or a content recommendation.

---

### User Story 3 - Identify a content opportunity (Priority: P1)

An operator can turn a recurring visitor need into a practical, evidence-backed
content idea.

**Why this priority**: The report is valuable only if it shortens the path from
conversation signal to an informed content decision.

**Independent test**: Seed repeated visitor questions from distinct conversations
paired with content-gap-eligible `no_context` or `grounded_degraded` assistant
outcomes, run the analysis, and verify the recommendation names the need, cites its
source evidence, suggests questions to cover, and does not claim that no document
exists in the corpus.

**Acceptance scenarios**:

1. **Given** a recurring theme with at least two content-gap-eligible sampled questions
   from two distinct conversations, **When** the report renders, **Then** it appears in
   the content-gap section with the observed signal counts and may include a content
   recommendation tied to that theme and its evidence.
2. **Given** a recommendation, **When** the operator expands it, **Then** they see a
   concise rationale, suggested title, and a bounded list of questions the content
   should answer.
3. **Given** a representative source remains available, **When** the operator selects
   it, **Then** the existing conversation detail opens at the authorized evidence.
4. **Given** all content-gap eligibility signals for a theme are false or unknown,
   **When** the report renders, **Then** it may be shown as a discussion theme but not
   as evidence of a content gap or a fabricated recommendation.

---

### User Story 4 - Start writing from a recommendation (Priority: P1)

An operator can use a content recommendation to open the canonical document composer
with an editable, unsaved seed.

**Why this priority**: A gap report is most useful when it shortens the path to the
existing writing workflow without giving an analysis agent authority to create content.

**Independent test**: From a completed report, select Start draft on a recommendation
and verify that the existing Write document experience opens with the recommendation's
suggested title in its title field and its questions rendered as an editable Markdown
list in its required content field, while no document exists until the operator uses
that composer's normal Save action.

**Acceptance scenarios**:

1. **Given** a content recommendation, **When** the operator selects Start draft,
   **Then** the dashboard opens the existing Write document flow rather than a new
   Audience Pulse content endpoint or editor.
2. **Given** the composer opens from a recommendation, **When** the operator views the
   form, **Then** the suggested title is in title and the bounded questions are in an
   editable Markdown list in content; this account- and workspace-bound transient seed
   is not saved, published, or sent to a provider by the handoff itself.
3. **Given** the operator cancels the composer or switches workspace, **When** the
   draft handoff is discarded, **Then** no document or cross-workspace draft remains.

---

### User Story 5 - Trust the boundaries of the analysis (Priority: P1)

An operator can tell what was measured, what was sampled, and when the analysis is
unavailable or incomplete.

**Why this priority**: A lightweight AI synthesis is useful only when its confidence
and coverage are visible.

**Independent test**: Exercise empty traffic, oversized history, invalid model output,
provider failure, a deleted source, prompt-injection text, and a workspace switch
during a request.

**Acceptance scenarios**:

1. **Given** a completed report, **When** the operator views its header, **Then** they
   see the date range, report time, exact population totals, analyzed sample size, and
   a plain-language coverage caveat when sampling occurred.
2. **Given** the provider fails or returns invalid structured output, **When** the
   operator requests a pulse, **Then** the UI shows a bounded retryable unavailable
   state when no saved report exists, or retains the previous report with a refresh
   failure notice. A failed attempt never replaces a valid saved report.
3. **Given** a source message is privacy-deleted, **When** a saved Audience Pulse report
   is next requested, **Then** the workspace's snapshot is invalidated and is not
   returned on that or any later page load.
4. **Given** a source is no longer authorized before presentation, **When** a saved
   report is requested, **Then** the entire snapshot is invalidated and the page receives
   `not_generated` rather than a partially redacted derived report.
5. **Given** visitor text contains instructions for the model, **When** the analysis
   runs, **Then** that text is treated as untrusted evidence and cannot alter tools,
   authorization, output shape, or application behavior.

### Edge Cases

- A workspace has no eligible visitor-authored messages in the period.
- All activity is concentrated in one long conversation.
- Traffic grows beyond the configured sample bound.
- Conversations contain multiple languages, short replies, off-topic chatter, or
  prompt-injection attempts.
- A theme is present in the sample but lacks enough evidence for a recommendation.
- A sampled visitor question has no linked assistant answer or no persisted grounding
  diagnostic.
- A theme has both grounded and unsupported sampled answers.
- A `no_support` answer was correctly out of scope or its generation was unavailable.
- A snapshot source is deleted or cannot be reauthorized after the snapshot is saved.
- A source conversation is deleted or access changes while the browser holds a report.
- A request is cancelled, times out, or the operator switches workspaces before it
  resolves.
- A refresh races a saved-report read after that read detected a deleted source.
- A second application replica receives a refresh while the first holds the workspace
  run lease, or the first process crashes while it holds that lease.
- The durable refresh rate or answer-usage limit is exhausted.
- The provider returns an unknown evidence identifier, excessive text, duplicate
  themes, or a schema-invalid response.

## Constitution Constraints

- Implementation MUST NOT begin until this replacement specification is explicitly
  approved.
- Backend changes MUST follow TDD: write a failing focused test before production
  behavior.
- Backend remains Node.js, frontend remains React, and PostgreSQL remains the system
  of record. Audience Pulse must not introduce a new storage system.
- Any HTTP contract MUST be Zod-backed and code-first OpenAPI. Generated OpenAPI and
  SDK/MCP artifacts and contract tests must remain aligned if the endpoint is public.
- The contract review MUST record that no document-worker AMQP payload, retry policy,
  or queue behavior changes; this feature has no worker handoff.
- Runtime prompt assets belong under backend/prompts/.
- The dashboard MUST reuse existing dark-theme, dashboard, responsive, and
  accessibility conventions.
- Audience Pulse dashboard routes MUST require a browser dashboard session and reject
  bearer-token access before the service runs.
- Visitor conversation text, prompts, completions, and source identifiers are customer
  data. They must be workspace-scoped and absent from logs, metrics, traces, and
  analytics.
- The model receives no tools, cannot write data, and must return bounded,
  Zod-validated structured output. Conversation content is untrusted input, not
  instruction.

## Architecture And Module Boundaries

### Data flow

1. On page access, the dashboard reads the current saved report for its workspace; this
   read never invokes the model.
2. On Analyze or Refresh, the session-only route rejects bearer authentication, then the
   service acquires a database-backed, replica-safe workspace run lease and dedicated
   durable rate-limit allowance before any provider work. A no-traffic result releases
   the lease without reserving provider usage. The lease is released in `finally`; a
   process crash releases its database lock/lease automatically.
3. The Audience Pulse service reads deterministic workspace-scoped aggregates and a
   bounded, stratified set of authorized conversation excerpts through a narrow history
   read port. Each sample item carries the typed outcome and persisted grounding state
   of its deterministically linked assistant answer when one exists; otherwise it is
   explicitly unknown. The source derives content-gap eligibility before returning data.
4. The service supplies opaque evidence IDs, aggregate context, server-owned grounding
   and content-gap eligibility signals, and fenced untrusted excerpts to a no-tools
   analysis agent.
5. The service validates the model result, verifies every evidence ID against the
   submitted sample, calculates all displayed counts, pulse cells, recurrence checks,
   theme grounding summaries, and content-gap eligibility server-side. Once the model
   result is validated, it commits the usage reservation before atomically replacing the
   workspace's saved snapshot so provider work remains metered if a later persistence
   operation fails; it releases only work that did not reach a validated completion and
   records a content-free audit outcome.
6. On every saved-report read, the service reauthorizes and rehydrates every source
   reference from the full prompt evidence set, not merely references rendered in a
   theme or recommendation. If any source is unavailable, it conditionally invalidates
   the exact snapshot revision that was read and returns `not_generated`; it never
   redacts one source from an otherwise derived report. If a concurrent refresh replaced
   that revision, it re-reads and validates the replacement before responding.
7. A Start draft action carries an already-visible recommendation title and questions
   through a typed, account- and workspace-bound browser-session handoff to the
   canonical document composer. The composer remains the only place that can create a
   document.

### Population and answer pairing

The server captures one UTC `analysisEnd` instant, sets `analysisStart` to exactly 30
days earlier, and uses the half-open interval `[analysisStart, analysisEnd)` for every
aggregate, sample, and source lookup. Weekly totals use UTC calendar-week buckets.

An eligible visitor question is a `messages` row that is `role = user`, has source
`customer` (or a legacy null source that maps to customer), belongs to the workspace,
falls in that interval, and belongs to an end-user conversation: its
`source_channel` is null or is not an operator-test channel. Dashboard test chat and
workbench replay are excluded. Each eligible row counts once toward the exact visitor
question total.

The history source orders messages within a conversation by `(created_at, id)`. For an
eligible visitor question, it finds the first subsequent assistant-role message whose
`created_at` is before `analysisEnd`, stopping at the next user-role message (whether or
not that next user message is eligible). If that answer is AI-authored, its persisted
grounding diagnostic and typed skill outcome are attached. If no such answer exists,
the first answer is human-authored, or it has no complete diagnostic, the sample item is
`unknown`. No answer text is included solely to derive this signal.

### Ownership

- A distinct `backend/src/modules/audiencePulse/` module owns request orchestration,
  sample policy, report validation, snapshot lifecycle, response mapping, prompt
  composition, and safe observability. It must not expand `QualityTurnsService` or
  Quality's triage-write boundary.
- Chat exposes a narrow, authorized `AudiencePulseHistorySource` from its public
  composition surface. It owns history persistence, answer pairing, typed-outcome
  classification, and authorization semantics; Audience Pulse must not read chat
  tables or repositories directly.
- The workspace inference factory owns workspace capability resolution, provider-client
  caching, generic model execution, cancellation, and provider behavior. It must not
  know Audience Pulse product rules.
- Application composition supplies the history port, authorized model runner, snapshot
  store, run gate, refresh-rate limiter, and route wiring. It assembles dependencies but
  owns no analysis policy.
- The dashboard owns layout, local loading state, and navigation to existing
  conversation detail. It must not calculate counts or reinterpret model output. It
  owns the one-shot draft intent but not document persistence.
- Documents owns the canonical Write document form and every document write. It may
  accept an editable initial-value seed; it must not know Audience Pulse analysis rules.

### Internal-agent foundations

Build only these reusable seams before or as the first slice of Audience Pulse:

1. **Dashboard-session guard**: a shared guard that accepts only the cookie/session
   branch of dashboard authentication, resolves its workspace, and rejects bearer tokens
   before permission checks, rate limiting, or service execution. Audience Pulse and the
   future Operator Copilot share it.
2. **Workspace structured-inference factory**: a shared factory that resolves the
   workspace's existing `chat` capability, uses the cached provider client, and returns
   a structured `ModelInferencePipeline` bound to a generic typed model-call context
   supplied by its caller. Audience Pulse composition supplies its refresh operation and
   uses the pipeline with JSON schema and Zod validation; the future Copilot supplies
   its own context and can adapt it to a tool gateway.
3. **Tool-shaped report port**: Audience Pulse exposes distinct read and explicit
   refresh operations with JSON-serializable, Zod-backed input/output. The future
   Copilot may adapt only the read operation as `audience_pulse.read`; it must not
   receive refresh authority. V1 does not mount either operation in the public MCP
   server.
4. **Document-composer intent**: a typed, transient `sessionStorage` handoff for opening
   the existing Write document flow. It is keyed to account and workspace, maps the
   suggestion title to `title` and questions to Markdown-list `content`, and is consumed
   and cleared on open, cancellation, or mismatch. It is a UI capability, not an agent
   tool and not a document-write API.
5. **Cost and concurrency guard**: a database-backed, replica-safe workspace run lease,
   dedicated durable refresh rate limit, and usage reservation seam. A refresh acquires
   the lease before it charges the refresh budget, so a concurrent `busy` outcome does
   not spend an attempt. It reserves only before a provider call and commits after
   validated model work, before the atomic snapshot save, so a later persistence failure
   cannot make provider work unmetered. It releases the reservation only when the model
   work is cancelled, invalid, or never completes; the lease has automatic crash recovery
   through the database.

### Deliberate non-architecture

This release adds no persistent topic, observation, membership, embedding, enrichment,
or report history. It adds exactly one current, workspace-scoped report snapshot and
the migration required to store it. It adds no background worker, queue message,
scheduled job, topic URL, or cross-workspace report cache. A browser refresh reads the
saved snapshot; only an explicit refresh generates a replacement.

## Analysis Input And Output

### Deterministic server data

For the fixed 30-day window, the server calculates from the authorized source:

- eligible visitor-question count by week;
- distinct eligible conversation count by week;
- optional existing channel breakdown when it is already available through the history
  read port; and
- the exact size of the population considered before sampling.

These are the only report-wide numerical claims. They must not be supplied by the
model.

For each sampled visitor question, the source also returns the persisted diagnostic of
its linked assistant answer when available: `grounded`, `degraded`, `no_support`, or
`unknown` when no diagnostic can be safely associated. The service derives every
theme-level support count from verified evidence membership. `no_support` and
`degraded` are observed answer-grounding signals, not proof that the corpus has no
relevant document.

Each sample item also carries a server-owned boolean `contentGapEligible`. It is never
model-inferred and is true only when the linked AI answer is the typed
`retrieval.answer` outcome `no_context` with `grounding = no_support`, or
`retrieval.answer` outcome `grounded_degraded` with `grounding = degraded`. It is false
for `out_of_scope`, `unavailable`, all other skills, human answers, unpaired answers,
and unknown/incomplete diagnostics. This classification reuses the existing typed
outcome semantics; it is not a corpus-coverage claim.

### Bounded evidence sample

The service chooses a deterministic, stratified sample across weeks and available
channels, capped by a documented conversation and character budget. Each entry contains
an opaque evidence ID, its week, its server-owned grounding signal and
`contentGapEligible` value, safe metadata needed for grouping, and the minimum
conversation excerpt needed to understand the visitor's information need.

The implementation plan must set and test the initial caps before implementation. When
the population exceeds either cap, the response must set sampled to true and render the
coverage caveat. It must not silently truncate history.

### Saved snapshot

Each workspace has at most one current Audience Pulse snapshot. It has a generated
revision and stores the validated report payload, fixed period, generation time, coverage
metadata, and opaque invalidation references for every evidence item submitted to the
model prompt, including items the model later omits from a theme or recommendation. It
does not store raw conversation excerpts, raw prompts, raw provider completion text, or
an analysis-history series.

Only a fully validated completed analysis may replace the snapshot. Provider and
validation failures leave a prior snapshot intact. On every saved-snapshot read, the
service reauthorizes and rehydrates every prompt-evidence reference. If any reference is
missing or unavailable, it conditionally invalidates the whole workspace snapshot using
the revision it read and returns `not_generated`; it must not return a partially redacted
derived report. If conditional invalidation loses a replace race, the service reads and
validates the newer revision instead of deleting it. V1 uses this read-time guarantee;
it does not add a generic deletion bus or database trigger.

### Theme membership and recommendation eligibility

The model may omit weak evidence or place it in a bounded uncategorized group, but each
submitted evidence ID may be the primary evidence for at most one discussion theme. A
rendered discussion theme must contain at least two submitted evidence IDs. The server
rejects duplicate membership across themes rather than silently choosing one.

A recommendation must name one parent theme and reference a non-empty subset of that
theme's evidence. It is valid only when that subset contains at least two
`contentGapEligible` evidence IDs from at least two distinct conversations. The server
derives this recurrence check, the content-gap projection, and every displayed support
count; the model may describe a need but cannot determine whether it qualifies.

### Analysis-agent contract

The prompt asks the agent to synthesize themes and recommendations, not to count
history or assert unsupported facts. The schema permits only:

- a short report summary;
- a bounded set of themes, each with a title, short description, and submitted opaque
  evidence IDs;
- a bounded set of content recommendations linked to one theme, with a suggested title,
  rationale, submitted evidence IDs, and questions to cover; and
- bounded caveats about gaps in the evidence.

The schema contains no arbitrary links, HTML, document mutations, tool calls, raw
provider diagnostics, or model-supplied count fields. The server rejects unknown IDs,
duplicate/empty theme evidence groups, theme groups with fewer than two items,
oversized strings, invalid recommendation-theme relationships, recommendation evidence
outside its parent theme, recommendations that fail the server-owned recurrence and
content-gap eligibility check, and schema-invalid output. It derives sample mention
counts, sample-based weekly intensity, grounding summaries, and content-gap projections
from the verified evidence IDs.

## Functional Requirements

### Request and data handling

- **FR-001**: The dashboard MUST provide an Audience Pulse destination that loads the
  current saved snapshot and offers Analyze last 30 days when no snapshot exists or
  Refresh when one does.
- **FR-002**: The first release MUST use a fixed rolling 30-day period; configurable
  ranges, scheduled runs, and report history beyond the one current snapshot are out
  of scope.
- **FR-003**: The system MUST retain at most one current Audience Pulse snapshot per
  workspace. A fully validated completed analysis MUST atomically replace that
  snapshot with a new revision; failed or no-traffic analyses MUST NOT overwrite it.
- **FR-004**: Opening or revisiting the page MUST read the saved snapshot without
  making an AI-provider request. The only generation trigger in v1 is an explicit
  authorized Analyze or Refresh action.
- **FR-005**: The dashboard-session-only guard MUST use only browser cookie/session
  authentication, reject bearer/API-token authentication before permission checks, rate
  limiting, or service execution, and then authorize the request, snapshot read, and
  every source read through the existing workspace-scoped operator permission for
  conversation/Quality evidence.
- **FR-006**: The service MUST calculate report-wide weekly question and conversation
  totals deterministically from the authorized source, before sampling and without a
  model call.
- **FR-007**: The service MUST use one UTC `analysisEnd`, the exact 30-day half-open
  interval ending at that instant, the defined eligible visitor population, and a
  bounded documented deterministic sample. It MUST disclose both population and sample
  size and make no all-workspace topic-frequency claim from that sample.
- **FR-008**: When no eligible evidence exists, an explicit analysis request MUST
  return a typed no-traffic result without calling an AI provider or replacing a prior
  snapshot.
- **FR-009**: The analysis request path MUST be read-only with respect to workspace
  content and MUST NOT delay, alter, or subscribe to visitor chat turns. Its only
  authoring integration is a client-side handoff to the existing document composer.

### Model safety and report integrity

- **FR-010**: The analysis agent MUST receive only the minimum bounded evidence and
  deterministic aggregate context required for this request.
- **FR-011**: Conversation excerpts MUST be delimited as untrusted data. The analysis
  agent MUST have no tools, actions, document access, or ability to make further data
  requests.
- **FR-012**: The service MUST validate model output against a narrow Zod schema and
  verify every referenced evidence ID, one-primary-theme membership, minimum theme
  evidence size, recommendation-parent relationship, recommendation evidence subset,
  field length, and list bound before saving or returning it.
- **FR-013**: The server MUST calculate displayed sample-theme counts, weekly pulse
  cells, per-theme `grounded`, `degraded`, `no_support`, and `unknown` counts, and
  `contentGapEligible` counts from validated evidence membership; the UI MUST label
  them as sample-based whenever the source population was capped.
- **FR-014**: A content gap MUST require the server-owned `contentGapEligible`
  classification: only typed `retrieval.answer:no_context` with `no_support`, or typed
  `retrieval.answer:grounded_degraded` with `degraded`, qualifies. `out_of_scope`,
  `unavailable`, human, unpaired, unknown, and all other outcomes MUST NOT qualify. The
  UI MUST NOT phrase a qualifying signal as proof that no workspace document exists.
- **FR-015**: If provider execution or validation fails, the service MUST return a
  typed unavailable result. It MUST never save partial output or overwrite a valid
  snapshot; the frontend may continue displaying that prior snapshot with a failure
  notice.

### API and frontend

- **FR-016**: The first release MUST expose one workspace-authorized GET read endpoint
  for the current snapshot and one POST analysis endpoint that creates or replaces it.
  It MAY additionally expose one narrow, dashboard-session-only POST evidence-anchor
  helper: it accepts an existing conversation/message ID only in a JSON body, requires
  `workspace.history.read`, reauthorizes that exact source, and returns at most that
  visitor message plus its next assistant reply. The helper MUST not call a provider,
  save a report, expose report history or topic detail, scan arbitrary history, export
  data, or create content. The release adds no other report-history, status, topic-detail,
  export, or content-write endpoint.
- **FR-017**: The saved snapshot MUST contain only the validated report structure,
  period, generation time, coverage metadata, generated revision, and opaque references
  for every evidence item submitted to the model prompt. It MUST NOT persist raw
  conversation excerpts, prompts, provider transcripts, or hidden reasoning.
- **FR-018**: The completed dashboard view MUST show period, generated time, exact
  weekly volume, population/sample coverage, discussion themes, server-derived
  grounding summaries, content gaps, representative evidence, recommendations, caveats,
  and an explicit Refresh action in evidence-first order.
- **FR-019**: Representative evidence MUST open only the existing authorized
  conversation detail. To avoid client-side cursor traversal for a historical source,
  it MAY use the bounded evidence-anchor helper in FR-016 before opening that detail.
  It MUST not place question text or source identifiers in the URL.
- **FR-020**: The UI MUST handle initial, loading, no-traffic, saved-completed,
  unavailable, refresh-failed, cancellation, deleted-snapshot, and workspace-switch
  states without showing a result from another workspace.
- **FR-021**: Theme, content-gap, and recommendation cards, the pulse visualization,
  Start draft controls, and status changes MUST be keyboard accessible, screen-reader
  understandable, usable without color, and responsive at narrow widths and 200% zoom.

### Privacy, observability, and operational behavior

- **FR-022**: A source conversation or message deletion MUST be detected before any
  subsequent saved-report response. Every saved-report read MUST reauthorize and
  rehydrate every prompt-evidence source; if any is unavailable, it MUST conditionally
  invalidate only the revision it read and return `not_generated`, never a partially
  redacted derived report. If a refresh replaced that revision concurrently, the read
  MUST validate the replacement rather than delete it.
- **FR-023**: Logs, metrics, traces, and analytics MAY record safe request IDs,
  workspace-safe identifiers, outcome, counts, duration, and provider failure class;
  they MUST NOT contain conversation text, prompt/completion content, evidence IDs
  that expose source records, or model-generated recommendation text.
- **FR-024**: The implementation MUST provide low-cardinality outcome and duration
  observability for this new provider path, plus audit events for refresh requested,
  completed, and failed containing only account/workspace/user, outcome, safe counts,
  and duration. It needs no worker-lag or projection telemetry because the release has
  neither.
- **FR-025**: A refresh MUST acquire a database-backed, replica-safe workspace run lease
  before a provider call and reject a concurrent refresh. The lease MUST be released on
  every terminal path and recover after a process crash. The request MUST pass a
  dedicated durable rate limit scoped to `audience_pulse.refresh`; a disabled browser
  button is not sufficient.

### Internal tool and authoring handoff

- **FR-026**: A recommendation MUST contain only an advisory content need, suggested
  title, evidence, and questions to cover. It MUST NOT invent factual answers,
  generate publish-ready content, change retrieval, or mutate a document.
- **FR-027**: The Audience Pulse module MUST expose separate, JSON-serializable,
  Zod-backed read and explicit-refresh operations behind an internal port. The dashboard
  HTTP adapter is the only v1 consumer; no public MCP-server tool or MCP authentication
  path is added. A future Copilot may receive only the read operation.
- **FR-028**: The dashboard MUST present discussion themes separately from content
  gaps. Only themes with at least two server-derived `contentGapEligible` evidence
  items from two distinct conversations may appear in the content-gap section or support
  a recommendation.
- **FR-029**: A Start draft action MUST invoke the existing Write document flow with an
  editable, browser-only `sessionStorage` seed keyed to the current account and
  workspace. It MUST map the already-visible suggested title to `title` and the bounded
  questions to Markdown-list `content`, and MUST NOT place recommendation text in a
  URL.
- **FR-030**: The composer MUST consume and clear a matching seed before opening, and
  clear it on cancellation or account/workspace mismatch. Selecting Start draft,
  navigating to the composer, cancelling, or switching workspace MUST NOT call a
  document-write endpoint or persist a draft. Only the existing composer’s explicit Save
  action may create a document.
- **FR-031**: A refresh MUST acquire the run gate before charging the dedicated durable
  refresh budget; a `busy` outcome MUST NOT consume that budget. The provider path MUST
  reserve the existing usage allowance only after a no-traffic check and run-gate
  acquisition. It MUST commit a validated model completion before the atomic snapshot
  save and release only when model work is cancelled, invalid, or never completes.
  History, snapshot, and usage-accounting failures MUST propagate as server errors rather
  than being presented as retryable provider unavailability.
- **FR-032**: The frontend MUST disable repeat submission while its request is active
  and use the existing request-cancellation behavior when the workspace changes or the
  page unmounts; this is supplementary to, not a substitute for, the server run gate.
- **FR-033**: A concurrent refresh MUST receive an explicit `busy`/HTTP 409 outcome;
  durable rate-limit and usage-limit rejections MUST receive distinct HTTP 429 outcomes.
  The frontend MUST render those as retry-later/capacity states, not provider or report
  validation failures.

## API Direction

The exact route namespace is finalized during planning with the existing dashboard
authorization owner. The intended shape is:

    GET /api/v1/quality/audience-pulse
    POST /api/v1/quality/audience-pulse
    POST /api/v1/quality/audience-pulse/evidence-anchor

GET reads the current saved snapshot without calling the provider. It returns
not_generated when no current snapshot exists, including after read-time source
revalidation detects a privacy deletion. It performs conditional revision invalidation so
a stale read cannot delete a newer refresh result.
POST has no user-selectable range in v1. It runs the fixed 30-day analysis and returns
no_traffic, unavailable, or completed; completed atomically replaces the saved
snapshot. A concurrent POST returns `AUDIENCE_PULSE_REFRESH_IN_PROGRESS`/HTTP 409; the
dedicated refresh budget is charged only after the run lease is acquired, and it and a
usage-limit rejection return distinct HTTP 429 errors. The dashboard presents all three
as retry-later/capacity states rather than a provider failure.

`POST /evidence-anchor` is not a report endpoint or a general history API. It is a
dashboard-session-only, body-only read helper requiring `workspace.history.read`; it
reauthorizes the supplied exact conversation/message pair and returns no more than that
eligible visitor source and its immediate next assistant reply. It calls no provider,
does not save or replace a snapshot, and keeps source identifiers out of the URL.

A completed response contains:

- period start/end and generated-at timestamp;
- exact weekly eligible question and conversation totals;
- coverage metadata: eligible population size, analyzed sample size, and whether the
  sample was capped;
- a bounded list of discussion themes with server-derived sample counts, weekly pulse
  values, and grounding summaries;
- a bounded server-derived content-gap projection that references only themes meeting
  the server-owned `contentGapEligible` recurrence rule;
- bounded, authorized representative evidence references/excerpts;
- bounded content recommendations with suggested titles, questions to cover, and a
  `start_draft` UI action; and
- coverage and analysis caveats.

There is one current snapshot per workspace, not a report identifier, deep link, or
history collection. The read response rehydrates every prompt-evidence source only after
current authorization succeeds; an unavailable source conditionally invalidates the
matching snapshot revision and returns `not_generated`. The public contract must never
return raw provider prompts or transcripts, hidden reasoning, arbitrary model fields, or
unavailable/deleted source text.

Within the application, the same `AudiencePulseReport` schema backs a narrow internal
read/refresh port. The HTTP routes adapt that port for the dashboard. A future Operator
Copilot may adapt only its read operation as `audience_pulse.read`; v1 does not add it
to the public MCP server.

## Frontend Experience

The page should feel like a compact decision aid, not a dense analytics suite:

    Audience Pulse                         Last saved analysis
    [ Analyze last 30 days ] or [ Refresh ]

    Saved report:
    [ exact visitor-question volume by week ]
    [ coverage: full population / analyzed sample ]
    [ topics being discussed: sample pulse + evidence ]
    [ observed content gaps: no/partial grounded support ]
    [ content opportunities: why it matters + questions + Start draft ]

Opening the page loads the saved report, including its period and generated time,
without starting analysis. The initial page explains that analysis is on-demand and
read-only. A saved report gives exact volume first, then coverage, topics, observed
grounding gaps, recommendations, and source evidence. A content gap is worded as a
recurring sample signal whose typed answer outcome had no or degraded grounded support;
it is never worded as proof that no document exists. The theme pulse uses accessible
labels as well as visual intensity. If the sample was capped, the caveat remains visible
near each sample-derived interpretation, not buried in a footer. A failed refresh leaves
the previous report visible and clearly identifies when that attempt failed.

Each recommendation has Start draft. It routes to the existing Knowledge → Documents
Write document experience and puts only an editable title plus Markdown-list questions
in a matching account/workspace `sessionStorage` seed. The composer consumes and clears
that seed before opening; it also clears mismatched or cancelled handoffs. The flow does
not use the URL, call a document-write endpoint, or create a document until the operator
uses that form's usual Save action.

## Assumptions And Dependencies

- The history owner can expose an authorized, workspace-scoped read port that supplies
  the deterministic aggregates, bounded excerpts, and linked persisted grounding
  snapshots plus the typed server-owned content-gap eligibility value, without leaking
  another workspace.
- PostgreSQL can host one workspace-scoped snapshot row, with a narrow report-store
  port, revision-conditional invalidation, and a database-backed run lease rather than
  a new analytics subsystem.
- A workspace structured-inference factory can resolve the workspace's existing `chat`
  capability, execute one bounded no-tools structured-output request, and report a
  typed failure without copying the global Agent Wizard model path.
- Existing dashboard navigation can open an authorized conversation detail from a
  source reference.
- The existing Documents view can accept a one-shot, browser-only initial-value seed
  while retaining the current document API and Save behavior as the sole write path.
- A dashboard-session-only guard can be introduced without changing bearer-token
  behavior for existing public/API surfaces.
- The application can supply a workspace-scoped run gate, dedicated durable rate-limit
  scope, existing usage reservation policy, and content-free audit sink without adding a
  worker or a generic deletion event bus.
- Prompt and model selection are implementation details, but the prompt must live
  under backend/prompts/ and the schema must be tested independently of the provider.
- Planning will confirm the exact authorization name, sampling limits, selection
  policy, snapshot invalidation hook, endpoint placement, and whether the current
  OpenAPI/SDK surface considers the endpoint public.

## Explicitly Out Of Scope

- Continuous or automatic analysis after a chat turn.
- Durable topics, observations, memberships, embeddings, centroids, labels, or
  recommendation records beyond the one current report snapshot.
- Historical bootstrap, backfill, reprojection, topic merge/split/redirect, or
  retention reconciliation.
- New retrieval-quality diagnosis, corpus similarity, related-document search, or
  automated retrieval remediation. V1 reuses only the persisted per-answer grounding
  diagnostic; it does not run a corpus-coverage query or prove document absence.
- AI-generated factual prose, full content briefs, automatic document creation,
  publishing, or any document mutation by Audience Pulse. The limited editable
  title/questions seed is the only authoring handoff in scope.
- Scheduled reports, notifications, exports, shared report links, a report history
  beyond the current snapshot, or collaboration workflow.
- Exact topic demand or a topic-by-week census across an unbounded workspace history.
- New database tables or migrations other than the one current-snapshot persistence
  record; external storage, background workers, queues, or AMQP payloads.
- New public MCP tools, visitor-facing skills, assistant routing changes, or changes
  to visitor-response latency.
- A generic privacy-deletion bus or database trigger. V1 uses the snapshot-store
  revision-conditional invalidation port on every saved-report read.

## Success Criteria

- **SC-001**: In a realistic operator walkthrough, an operator can identify at least
  one recurring visitor need, distinguish it from an observed content gap, and identify
  the questions a proposed content item should cover in under two minutes.
- **SC-002**: Fixture tests show exact weekly question and conversation totals reconcile
  with the authorized database population; no model-supplied number is rendered as a
  report-wide metric.
- **SC-003**: After a completed analysis, repeated page loads retrieve the saved
  workspace snapshot and issue zero additional provider calls; only an explicit
  Refresh calls the provider and atomically replaces it on success.
- **SC-004**: Every rendered source reference originates in the authorized submitted
  sample. A deleted or unavailable prompt-evidence source conditionally invalidates the
  matching saved snapshot revision, so no partially redacted derived report is rendered
  and a stale read cannot delete a newer refresh.
- **SC-005**: No-traffic requests issue zero provider calls; invalid output and provider
  failures preserve any prior valid snapshot and otherwise produce a clear unavailable
  state with no partial recommendations.
- **SC-006**: Prompt-injection content in fixtures cannot alter the validated output
  shape, access tools, expose hidden context, or cause a write.
- **SC-007**: Focused backend tests cover authorization, snapshot read/write,
  replacement, invalidation, sampling disclosure, aggregate calculation, validation,
  source-reference verification, no-traffic, and failure paths; Playwright covers the
  primary dashboard states and accessible narrow layout.
- **SC-008**: Observability checks show no raw conversation text, prompts, completions,
  source excerpts, or recommendation prose in logs, metrics, traces, or analytics.
- **SC-009**: The final implementation introduces only the bounded snapshot migration;
  no worker, queue, or continuous-turn-path change, and local CI plus the applicable
  OpenAPI/SDK checks pass without contract drift.
- **SC-010**: Fixtures prove that a theme's `grounded`, `degraded`, `no_support`,
  `unknown`, and `contentGapEligible` counts are calculated from submitted evidence
  membership. Only the two typed qualifying retrieval outcomes can produce a content
  gap; unknown, human, out-of-scope, unavailable, and unpaired evidence cannot.
- **SC-011**: In Playwright, Start draft opens the canonical document composer with an
  editable title and Markdown-list recommendation seed, puts no recommendation text in
  the URL, refuses cross-workspace handoff, and creates no document until its existing
  explicit Save control is used.
- **SC-012**: Focused backend tests prove bearer authentication is rejected before the
  Audience Pulse permission, rate-limit, or service layers, and concurrent refreshes
  cannot make more than one provider call for a workspace across application replicas;
  a crashed refresh lease recovers safely.
- **SC-013**: Focused backend tests prove usage is reserved only for provider work,
  retained after a validated model completion even when snapshot persistence or usage
  accounting fails, and released only before model completion; audit/telemetry fixtures
  contain only safe identifiers, outcome, counts, and duration.
