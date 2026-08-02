# Feature Specification: Continuous Content Planning

**Feature Branch**: `find-next-good-issue`
**Created**: 2026-08-02
**Status**: Approved for implementation
**Source**: GitHub issue #939, the content-planning design discussion in this
workspace, and the agreed replacement of weekly snapshots with continuous
enrichment.

## Existing Behavior And Feature Delta

Radioso's Quality surface currently helps an operator review individual assistant
answers. It shows trustworthy Quality signals, a rolling health summary, grounding
diagnostics, answer-level filters, triage state, conversation evidence, and Eval
handoff. It does not turn those answers into a content plan.

The normal turn path already does most of the expensive understanding work needed for
that plan:

- turn interpretation resolves conversational context and semantic rewrites;
- retrieval embeds active semantic queries for vector search;
- assistant-turn persistence records the visitor question, answer outcome, and
  grounding diagnostic;
- Quality defines the shared population that excludes operator-test traffic and
  human-authored takeover replies.

Today, the semantic vectors are transient, question fragments such as “yes” or “2”
are not classified for reporting purposes, and no durable topic projection exists.
Issue #939 proposed periodically clustering unsupported answers into immutable
reports. The accepted direction is different: continuously maintain a workspace topic
catalog from all eligible visitor interests, reuse turn-time embeddings, overlay
grounding evidence, and generate content advice only when a topic materially changes.

The result is a near-current operator experience, not a report-generation workflow:

1. a dedicated **Content plan** destination under Activity;
2. a rolling 30-day view of visitor interests compared with the preceding 30 days;
3. ranked opportunities where popular questions receive reduced or no grounding;
4. evidence-first content briefs and direct paths into answer review and Knowledge;
5. honest visibility into processing lag, sparse evidence, and unavailable analysis.

## Product Decisions From Discussion

- The first release serves one workspace operator. It does not add assignments,
  notifications, approval workflow, exports, or collaboration state.
- Topic projection is enriched after each eligible committed turn. There is no
  weekly/monthly generation button and no recurring full-report job.
- Existing retrieval embeddings are reused when compatible. Only missing vectors are
  generated asynchronously in bounded batches.
- All substantive visitor interests contribute to demand, not only failed answers.
- `grounded`, `degraded`, `no_support`, and `not_evaluated` remain distinct. Unknown
  grounding is never counted as failure or success.
- Social reactions, confirmations, cancellations, menu choices, routine step inputs,
  and clarification values do not become independent topics merely because they are
  user messages.
- A substantive contextual follow-up is resolved into a standalone semantic intent
  before clustering. A clarification value enriches the pending earlier interest and
  does not increment demand by itself.
- A question that does not fit an existing topic starts a provisional topic. It is
  visible as emerging evidence without receiving a confident generated label or
  recommendation prematurely.
- Recommendations identify knowledge scope and questions to cover. They never invent
  business facts, write a finished policy, publish content, or change assistant
  behavior.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Choose The Next Content Action (Priority: P1)

A workspace operator opens Content plan and can immediately identify the strongest
content opportunity, understand why it matters, and begin the appropriate remediation
without reading dozens of individual conversations.

**Why this priority**: The primary product outcome is a better next content decision,
not topic clustering for its own sake.

**Independent Test**: Seed several topics with different demand, trend, grounding,
triage, and related-document evidence. Open Content plan and verify that the strongest
credible opportunity is presented first with its evidence, questions to answer, and
the correct remediation action.

**Acceptance Scenarios**:

1. **Given** several visitor-interest topics, **When** the operator opens Content plan, **Then** the default view ranks credible content opportunities using server-owned ordering and presents one recommended next action prominently.
2. **Given** a high-demand topic with repeated reduced or no-support answers, **When** it is the strongest credible opportunity, **Then** the recommendation explains the demand and support evidence and lists representative questions the content should answer.
3. **Given** no related workspace document is found, **When** the operator acts on the opportunity, **Then** they can start writing or importing knowledge from the topic detail without the system inventing factual content.
4. **Given** a potentially related document is found, **When** the operator opens the opportunity, **Then** the primary action is to review that document or investigate retrieval before creating a duplicate.
5. **Given** an opportunity has too little evidence for a recommendation, **When** it appears, **Then** the UI labels it as emerging and offers evidence review rather than presenting speculative advice as a plan.

---

### User Story 2 - Understand Visitor Interests And Grounding Coverage (Priority: P1)

An operator can see what visitors have asked about over the rolling 30-day period,
including well-covered interests, and can distinguish demand from grounding quality.

**Why this priority**: Clustering only failures hides popular successful topics and
makes an isolated miss appear as important as broad demand.

**Independent Test**: Seed well-grounded, degraded, unsupported, and unevaluated turns
across several semantic topics and both comparison windows. Verify that the summary
and topic list reconcile with the eligible source population and preserve honest
denominators.

**Acceptance Scenarios**:

1. **Given** eligible visitor questions in the current and comparison windows, **When** the operator opens the all-interests view, **Then** every mature topic shows current demand, previous-period comparison, and distinct-conversation evidence.
2. **Given** a topic containing grounded, degraded, no-support, and unevaluated answers, **When** the operator views its coverage, **Then** all four categories are shown and the reduced/no-support rate uses only grounding-evaluated answers as its denominator.
3. **Given** a high-demand topic whose answers are well grounded, **When** the operator views the report, **Then** it appears in all interests but not as a content-gap recommendation.
4. **Given** a correct out-of-scope decline or another turn without grounding evaluation, **When** it contributes to a substantive visitor interest, **Then** it may increase demand but does not independently create a grounding-gap recommendation.
5. **Given** one user message contains several independently interpreted semantic subqueries, **When** topic demand is calculated, **Then** the message may appear in each relevant topic but is counted once in the report-wide visitor-question total and once per topic.

---

### User Story 3 - Handle Conversational Fragments Correctly (Priority: P1)

The content plan reflects visitor information needs rather than every message sent in
the conversation.

**Why this priority**: Naively embedding and clustering every user message creates
topics such as “Yes,” inflates demand during clarifications, and turns normal control
replies into false grounding failures.

**Independent Test**: Run multilingual conversations containing social reactions,
confirmations, choices, clarification answers, referential follow-ups, mixed turns,
and topic changes. Verify the resulting interest observations and counts.

**Acceptance Scenarios**:

1. **Given** a visitor replies “yes,” “no,” “go ahead,” or selects an offered option, **When** the reply functions only as conversational control, **Then** it creates no independent topic observation and no grounding-gap evidence.
2. **Given** the assistant asks which identity provider the visitor means and the visitor replies “Okta,” **When** the assistant subsequently answers the resolved request, **Then** the system records one contextualized interest such as “Does the product support Okta?” rather than separate question and “Okta” topics.
3. **Given** a visitor asks “What does that cost?” after discussing an Enterprise plan, **When** the turn is interpreted as a substantive follow-up, **Then** the standalone semantic intent references Enterprise pricing and is eligible for normal clustering.
4. **Given** a short message remains ambiguous after available context, **When** reporting eligibility cannot be established, **Then** it remains pending until the conversation resolves it or is excluded; it is never force-assigned to a topic.
5. **Given** a message combines politeness with a substantive question, **When** the normal turn interpretation preserves the question, **Then** that substantive intent is observed and the polite wording does not suppress it.
6. **Given** equivalent interactions occur in different languages, **When** eligibility is decided, **Then** they follow the same behavior without English keyword or regular-expression rules.

---

### User Story 4 - See New Demand Without Waiting For A Report Run (Priority: P1)

An operator sees newly committed visitor interests reflected shortly after the answer
completes, without triggering analysis manually or delaying the visitor response.

**Why this priority**: Near-current insight and smooth load are the reason to replace
periodic report generation with continuous projection.

**Independent Test**: Submit eligible turns that reuse an existing vector, need a
fallback vector, match a mature topic, and form a provisional topic. Verify update
latency, visitor-facing latency, idempotency, and visible freshness state.

**Acceptance Scenarios**:

1. **Given** an eligible answered turn with a compatible semantic embedding, **When** the turn commits, **Then** the same vector is reused and no additional embedding-provider request is made for that semantic intent.
2. **Given** an eligible turn without a reusable vector, **When** the turn commits, **Then** the visitor response completes normally and the missing vector is generated asynchronously in a bounded batch.
3. **Given** a new intent closely matches a mature topic, **When** projection completes, **Then** the topic's demand and grounding evidence include it without regenerating the entire report.
4. **Given** a new intent does not fit any mature or provisional topic, **When** projection completes, **Then** a provisional topic is created and shown under emerging evidence.
5. **Given** a turn is delivered more than once to the projection path, **When** each delivery is processed, **Then** only one observation per message and semantic subquery contributes to counts.
6. **Given** projection is delayed, **When** the operator opens Content plan, **Then** the last processed time and pending count are visible and already processed insights remain usable.

---

### User Story 5 - Inspect Evidence And Continue To Remediation (Priority: P2)

An operator can inspect a topic before trusting the recommendation and can move into
the existing Quality and Knowledge workflows without losing the topic context.

**Why this priority**: Generated labels and briefs are navigation aids, not evidence.
The operator needs a short path from claim to source turns and then to action.

**Independent Test**: Open a topic from a shareable URL, inspect representative
questions and related documents, open a source conversation, switch to the filtered
answer review, and start a new inline document from the brief.

**Acceptance Scenarios**:

1. **Given** a mature topic, **When** the operator selects it, **Then** a shareable detail state shows demand, grounding composition, evidence strength, recommendation, representative questions, affected agents/channels, and related documents.
2. **Given** a representative question is still available, **When** the operator selects it, **Then** the existing conversation detail opens at the relevant answer.
3. **Given** the operator chooses View answers, **When** the Quality answer-review view opens, **Then** it is filtered to the topic's current-window member turns and offers a path back to that topic.
4. **Given** the recommendation is to add knowledge, **When** the operator chooses Write document, **Then** the existing inline-document flow opens with a suggested title and a question-based outline, but no generated factual answers.
5. **Given** the operator prefers another ingestion method, **When** they choose another add method, **Then** the existing import, crawl, or connector flow opens without changing its behavior.
6. **Given** a related document is suggested, **When** the operator selects it, **Then** its existing Knowledge detail opens directly.

---

### User Story 6 - Trust Partial And Changing Analysis (Priority: P2)

An operator can distinguish strong evidence from sparse, delayed, failed, or stale
analysis and is never shown fabricated precision.

**Why this priority**: Continuous AI-assisted reporting is only useful when the UI
communicates what is measured, inferred, pending, and unavailable.

**Independent Test**: Exercise empty traffic, bootstrap, low volume, no evaluated
grounding, failed label generation, failed related-document analysis, embedding-space
change, deleted evidence, and a fully caught-up healthy state.

**Acceptance Scenarios**:

1. **Given** no eligible traffic exists, **When** the operator opens Content plan, **Then** the page explains what will appear after real visitor questions without describing the absence as healthy coverage.
2. **Given** topics exist but none has grounding-evaluated turns, **When** the report loads, **Then** demand remains visible, coverage is labeled unmeasured, and no grounding-gap recommendation is generated solely from missing diagnostics.
3. **Given** topic labeling or recommendation enrichment fails, **When** core topic membership and counts are valid, **Then** the evidence remains visible with a bounded unavailable state and no placeholder recommendation presented as fact.
4. **Given** the active embedding space changes, **When** observations are being reprojected, **Then** vectors from incompatible spaces are never compared and the UI identifies the analysis as updating while retaining the last coherent view.
5. **Given** privacy deletion removes a source message, **When** the topic is viewed, **Then** the excerpt and source link disappear, aggregate evidence is recomputed, and the UI states that some evidence is no longer available when relevant.

### Edge Cases

- A visitor sends only social messages or control replies during the entire window.
- A clarification begins in the comparison window and resolves in the current window.
- A visitor abandons a clarification or changes topic instead of answering it.
- One message yields duplicate or overlapping semantic subqueries.
- One long conversation repeats the same question many times.
- A single question does not match another question before it ages out.
- Two provisional topics later prove equivalent across different languages.
- A mature topic receives an outlier that is close to its centroid but semantically
  incoherent with its representative members.
- A topic's wording changes over time while the underlying information need remains
  stable.
- The embedding provider fails, returns a malformed vector, changes dimensions, or is
  rate-limited.
- The clustering assignment succeeds but label, recommendation, or related-document
  analysis fails.
- A document is added, updated, reprocessed, or deleted after a recommendation was
  generated.
- A triage state or linked Eval result changes after the original turn was observed.
- The projection worker stops while visitor traffic continues and later resumes.
- Initial rollout finds historical traffic whose turn-time vectors were never stored.
- The current rolling window expires observations while the dashboard is open.
- Two browser sessions read the same topic while it is merged into another topic.
- Topic labels or representative questions are long, multilingual, or bidirectional.
- Visitor questions contain prompt-injection instructions aimed at the labeling or
  recommendation model.
- A workspace switch occurs while a report or topic-detail request is in flight.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this specification is explicitly approved.
- Backend changes MUST follow TDD: failing tests before production implementation.
- Backend remains Node.js, frontend remains React, and PostgreSQL with `pgvector`
  remains the system of record and similarity substrate.
- Public HTTP changes MUST be defined through Zod-backed code-first OpenAPI, generated
  OpenAPI artifacts MUST be regenerated, and SDK/MCP contract types and contract tests
  MUST remain aligned.
- The contract review MUST explicitly confirm that document-worker AMQP payloads,
  retries, and queue tests are unchanged unless planning introduces a cross-service
  payload.
- Runtime prompt assets introduced or changed for reporting disposition, topic
  labeling, or recommendation enrichment MUST live under `backend/prompts/`.
- Product meaning MUST NOT be inferred from English keyword lists, regular
  expressions, answer copy, topic labels, or citation formatting.
- The admin experience MUST reuse the existing dark theme, dashboard tokens,
  typography, spacing, badges, buttons, drawers, tables/lists, focus treatments, and
  responsive conventions.
- Frontend-visible journeys and presentation states MUST prefer Playwright coverage.
  Frontend unit tests are limited to API adapters, URL state, transforms, formatting,
  and other non-visual behavior.
- Visitor questions, vectors, related document text, prompts, completions, and
  recommendations are customer data. They MUST remain workspace-scoped, least-
  privilege protected, and absent from logs, metrics, traces, and analytics.
- Generated recommendations MUST treat visitor questions as untrusted input, use
  bounded validated structured output, have no tools, and never mutate documents,
  triage, Eval state, retrieval, routing, or assistant behavior.
- Operator and API documentation MUST explain the Content plan workflow, freshness,
  coverage denominators, emerging evidence, recommendation limitations, and public
  contracts.

## Architecture Constraints *(mandatory)*

- **Domain Boundary**: A focused Content Planning module owns durable observations,
  topic membership, opportunity semantics, enrichment state, and Content plan reads.
  It consumes a narrow Quality evidence/population port; it does not expand Quality
  from its existing read-and-triage boundary into a projection writer or provider-call
  orchestrator. Existing Quality turn-list, stats, and triage services remain unchanged
  in responsibility.
- **Turn-Understanding Boundary**: Chat turn interpretation may emit a capability-
  neutral `ConversationInteractionRole` of `substantive_new`,
  `substantive_followup`, `clarification_value`, `control`, `social`, or `unresolved`,
  plus the contextual semantic intent where applicable. Existing lifecycle outcomes
  for social, routine, and clarification flows override a conflicting model-derived
  role. Chat does not decide topic assignment, opportunity priority, or UI
  presentation.
- **Retrieval Boundary**: Retrieval exposes reusable semantic vector envelopes through
  a narrow consumer-neutral result containing the semantic text identity, vector, and
  embedding-space fingerprint. Retrieval's actual contextual semantic query and
  subqueries are the canonical contribution inputs when retrieval ran; Content
  Planning MUST NOT perform a parallel rewrite. Retrieval MUST NOT import or call
  Content Planning.
- **Durability Boundary**: An answered turn that is eligible for later projection MUST
  be discoverable after process failure. Delivery and processing are idempotent and
  at-least-once; a best-effort in-memory callback MUST NOT be the only record that an
  observation is pending. Planning must choose an atomic turn projection/outbox seam or
  a replayable committed-turn cursor and document why it cannot permanently lose turns.
- **Critical-Path Rule**: Topic matching, fallback embeddings, label generation,
  recommendation generation, related-document analysis, reconciliation, and
  historical bootstrap MUST NOT be awaited by visitor-facing answer completion.
- **Projection Rule**: Normal work is incremental: one eligible semantic observation
  is assigned to a topic or a provisional topic, and only affected topic state becomes
  dirty. There is no recurring full report generation or immutable report snapshot.
- **Read-Model Rule**: Rolling current/comparison metrics derive from source
  observations and the shared Quality population semantics. Aging, privacy deletion,
  triage changes, and Eval verification changes must be reflected without rewriting
  historical answer meaning or treating cached counters as authoritative forever.
- **Embedding-Space Rule**: Every stored vector and centroid carries a space
  fingerprint. Incompatible spaces are never compared. A profile change uses a
  bounded, resumable reprojection path and keeps the last coherent view readable until
  the replacement is safe to expose.
- **Topic-Stability Rule**: New non-matches create provisional topics. Assignment uses
  bounded semantic similarity plus a cohesion guard. Reconciliation may merge
  equivalent topics while preserving redirectable topic identity. Automatic topic
  splitting is out of scope for the first release; thresholds must instead resist
  incoherent growth and be evaluated on a committed fixture.
- **Enrichment Rule**: Labels and recommendations are generated only when a topic first
  becomes mature or materially changes. Enrichment is debounced, bounded, retryable,
  and versioned independently from topic membership so failed generation cannot hide
  valid demand and grounding evidence.
- **Corpus-Evidence Rule**: Related-document similarity is supporting evidence, not a
  root-cause diagnosis. Finding a related document changes the recommended action to
  review/investigate; it does not prove retrieval is configured correctly or that the
  document fully answers the questions.
- **Presentation Boundary**: Backend contracts own eligibility, aggregation, ranking,
  rates, trend, and recommendation action. Frontend adapters map the typed contract;
  dashboard components own visual hierarchy and interactions but MUST NOT recompute
  domain scores or classify messages.
- **Composition Rule**: Application composition owns the default observation sink,
  processor lifecycle, embedding and generation adapters, and cross-module wiring.
  Product rules remain in the owning domains.
- **Responsibility-Limited Files**: `quality/service.ts`, `quality-view.tsx`,
  `chatTurnLifecycle.ts`, retrieval pipeline stages, HTTP route handlers, and dashboard
  shell/navigation files remain readable orchestration or presentation surfaces. The
  feature MUST introduce focused services/components rather than adding the complete
  workflow to any of them.
- **Anti-Goals**: Do not cluster raw messages synchronously in an HTTP request. Do not
  add a Redis/vector database, a weekly report job, a manual Refresh report action, an
  English fragment filter, a second definition of the Quality population, or a
  frontend-owned opportunity score. Do not publish AI-written business facts or
  automatically resolve historical Quality turns when a document is added.

## Requirements *(mandatory)*

### Functional Requirements

#### Observation eligibility and contextual intent

- **FR-001**: The system MUST evaluate every successfully committed end-user turn for
  content-planning eligibility using structured turn interpretation, lifecycle state,
  source metadata, and assistant outcome rather than message-text heuristics.
- **FR-002**: Operator-test traffic, human-authored takeover replies, system messages,
  and other turns excluded from the shared Quality population MUST NOT contribute to
  content-planning demand or grounding metrics.
- **FR-003**: Each eligible substantive information need MUST produce an idempotent
  observation identity based on its user message and semantic subquery; retries MUST
  NOT increment demand twice.
- **FR-004**: Social-only reactions, conversational acknowledgements, confirmations,
  cancellations, menu choices, routine step values, and clarification values MUST NOT
  create independent topic observations when they contain no substantive information
  need.
- **FR-005**: A clarification value that resolves an earlier pending question MUST
  enrich or finalize that earlier interest and MUST NOT create an additional demand
  count solely for supplying the missing value.
- **FR-006**: A substantive contextual follow-up MUST be represented by a standalone
  semantic intent that includes the necessary prior subject while retaining the raw
  visitor wording as evidence.
- **FR-007**: A short or ambiguous turn that cannot be resolved from available context
  MUST remain pending for at most the conversation's next resolving turn or be
  excluded; it MUST NOT be force-clustered.
- **FR-008**: One message with distinct semantic subqueries MAY contribute to multiple
  topics. Report-wide question volume MUST count distinct user messages, and each
  topic's demand MUST count a source message at most once.
- **FR-009**: Demand MUST include substantive, eligible questions regardless of
  grounding verdict, triage state, or whether the assistant correctly declined an
  out-of-scope request.
- **FR-074**: The reporting-role decision MUST use exactly the structured interaction
  roles defined by the Turn-Understanding Boundary. Lifecycle-confirmed social,
  routine-control, and clarification transitions MUST take precedence over a
  conflicting inferred role, and unusable role output MUST become `unresolved` rather
  than fall back to a text classifier.
- **FR-075**: When retrieval ran, the contribution's contextual intent MUST be the
  same semantic query or bounded semantic subqueries that retrieval actually embedded
  and searched. Content Planning MUST NOT issue a second rewrite call or construct a
  competing contextual query.

#### Continuous projection and topic lifecycle

- **FR-010**: Compatible semantic embeddings already generated during the turn MUST be
  reused without an additional provider request and MUST retain their embedding-space
  fingerprint.
- **FR-011**: Eligible observations without a compatible reusable vector MUST enter a
  durable missing-embedding state and be embedded asynchronously in bounded batches.
- **FR-012**: Embedding, projection, and enrichment work MUST never delay or fail the
  visitor-facing answer after that answer can otherwise commit successfully.
- **FR-013**: A ready observation MUST be compared only with active topics in the same
  workspace and embedding space.
- **FR-014**: An observation meeting the configured semantic and cohesion thresholds
  MUST join the closest qualifying topic; otherwise it MUST create or join a
  provisional topic.
- **FR-015**: A provisional topic MUST be visible in an Emerging questions section
  with its actual representative question and evidence count, but MUST NOT receive a
  confident generated label, priority, or content brief before the maturity threshold
  is met.
- **FR-016**: A provisional topic reaching the maturity threshold MUST become a mature
  topic, receive a stable public identifier, and become eligible for labeling,
  ranking, and recommendation enrichment.
- **FR-017**: Equivalent provisional or mature topics MAY be merged by bounded
  reconciliation. Existing authorized links to a merged topic MUST resolve to the
  surviving topic without exposing another workspace's identifiers.
- **FR-018**: Automatic topic splitting MUST NOT be part of the first release. The
  assignment and merge thresholds MUST be tuned to reject incoherent members rather
  than rely on later splitting.
- **FR-019**: Topic centroids and representative members MUST update incrementally
  without regenerating unaffected topics.
- **FR-020**: Observations needed for the current and comparison windows MUST be
  retained for at least 60 days and removed or anonymized consistently with source
  message retention and privacy deletion. Retention beyond the reporting need MUST be
  minimized and documented.
- **FR-021**: Existing workspaces MUST receive one bounded, resumable bootstrap of the
  preceding 60 days. Historical turns without stored vectors MAY use batched fallback
  embeddings; the UI MUST distinguish bootstrap progress from a complete report.
- **FR-022**: A change to the active embedding space MUST start bounded reprojection,
  MUST NOT compare incompatible vectors, and MUST retain the last coherent projection
  until the replacement reaches a safe handoff state. Before promotion, target topics
  MUST be matched to the prior coherent generation only through shared observation
  memberships. An unambiguous one-to-one match carries the prior public ID; a
  many-to-one merge keeps its new survivor and creates in-target redirects for the old
  IDs; a split or otherwise ambiguous match keeps new IDs without guessing.
- **FR-076**: A provisional topic with no live observations after window expiry,
  retention, or privacy deletion MUST retire and stop appearing in reads. Its former
  identifier MUST use the same not-found behavior as an unknown topic, and the retired
  row MUST NOT retain a centroid, representative IDs, generated prose, or related
  document evidence.
- **FR-077**: A merged topic redirect MUST resolve transitively to the current
  surviving topic with cycle protection. Redirect state MUST be retained for at least
  90 days so links created during the current and comparison windows remain useful,
  including after an embedding-space promotion.
- **FR-078**: Historical bootstrap and embedding-space reprojection MUST use versioned
  per-workspace request-rate and spend budgets. Exhausting a budget MUST pause safely,
  expose processed/total progress and a typed `budget_paused` state, and resume later
  without duplicating observations or presenting incomplete totals as complete.

#### Demand, grounding, trend, and priority semantics

- **FR-023**: The report MUST use a rolling current window of the last 30 complete
  24-hour periods through its `asOf` boundary and compare it with the immediately
  preceding equal-length window; all boundaries MUST be explicit UTC instants.
- **FR-024**: The report summary MUST expose current-window distinct eligible user
  messages, distinct conversations, mature topic count, provisional observation
  count, credible opportunity count, and projection freshness.
- **FR-025**: Each mature topic MUST expose current and comparison question counts,
  distinct conversation counts, current demand share, change, and a typed trend of
  `new`, `rising`, `steady`, `falling`, or `insufficient_data`.
- **FR-026**: Trend classification MUST use deterministic, versioned server-owned
  rules and MUST label low-volume comparisons as insufficient rather than reporting a
  dramatic percentage from a negligible sample.
- **FR-027**: Each mature topic MUST expose current-window counts for `grounded`,
  `degraded`, `no_support`, and `not_evaluated` answers.
- **FR-028**: The reduced/no-support rate MUST equal `(degraded + no_support) /
  (grounded + degraded + no_support)` and MUST be null when the denominator is zero.
- **FR-029**: Report-wide and topic-level support metrics MUST describe answer-level
  grounding. When one multi-intent answer contributes to several topics, the UI and
  API documentation MUST NOT claim subquery-level grounding precision.
- **FR-030**: Opportunity eligibility MUST use current-window reduced/no-support
  evidence that remains open or acknowledged and lacks a passing linked Eval
  verification. Resolved, dismissed, or passing-verified evidence remains in
  historical demand and grounding coverage but MUST NOT independently raise the
  current remediation priority.
- **FR-031**: Correct out-of-scope and other unevaluated turns MUST NOT lower the
  grounding rate or independently create an add-content recommendation.
- **FR-032**: Opportunity ordering and priority reasons MUST be deterministic,
  versioned, and owned by the backend. Ordering MUST favor active no-support evidence,
  then active degraded evidence, then distinct-conversation demand, then positive
  trend, with a stable identifier as final tie-breaker.
- **FR-033**: Evidence strength MUST be expressed using both sample size and a typed
  band. The UI MUST show the sample basis (for example, “based on 6 conversations”)
  rather than rely on an unexplained confidence badge.
- **FR-079**: Evidence-strength bands MUST use grounding-evaluated distinct
  conversations: `none` for zero, `low` for one through four, `medium` for five
  through nineteen, and `high` for twenty or more. A version change MUST be explicit
  in the contract and deterministic tests.
- **FR-080**: The report-wide reduced/no-support headline MUST always name its
  evaluated-answer denominator. Below medium evidence strength it MUST show a typed
  `insufficient_measured_turns` state and raw counts rather than a percentage-only
  headline.

#### Labels, recommendations, and corpus evidence

- **FR-034**: Mature topic labeling MUST produce a concise operator-language label and
  description from bounded representative questions using structured validated model
  output.
- **FR-035**: A topic MUST become dirty for enrichment only when it first matures or
  materially changes in membership, grounding mix, opportunity state, or related
  document evidence. Every single new message MUST NOT trigger a generative call.
- **FR-036**: Dirty-topic enrichment MUST be debounced, bounded, retryable, and
  idempotent. A newer topic revision MUST supersede stale in-flight output.
- **FR-037**: At most the ten highest-ranked credible opportunities MUST receive a
  generated content brief in the first release. Other topics MUST remain visible with
  evidence and an explicit `outside_analysis_cap` state.
- **FR-038**: A content brief MUST contain a suggested title, a short evidence-based
  rationale, three to seven questions the content should answer, a suggested content
  shape, and an evidence-strength statement.
- **FR-039**: A content brief MUST NOT include invented prices, policies, eligibility
  rules, timelines, legal claims, or other business facts absent from workspace
  knowledge. It MUST state that the operator must verify facts before publishing.
- **FR-040**: Related-document analysis MUST return at most five authorized workspace
  documents and MUST treat semantic similarity as possible relevance, not proof of
  completeness or retrieval correctness.
- **FR-041**: Recommendation actions MUST distinguish `add_content`,
  `review_existing_content`, `investigate_retrieval`, and `monitor`. The evidence used
  to choose the action MUST be returned separately from generated prose.
- **FR-042**: Label or brief failure MUST NOT hide valid topic membership, demand,
  grounding, trend, or priority. The API and UI MUST represent pending, stale,
  unavailable, and outside-cap enrichment explicitly.
- **FR-043**: Adding, updating, reprocessing, or deleting a related document MUST mark
  affected credible opportunities for bounded corpus-evidence refresh; it MUST NOT
  rewrite historical grounding diagnostics or automatically resolve Quality turns.
- **FR-081**: Recommendation action selection MUST be deterministic and versioned:
  `monitor` applies when a topic has no credible active gap; `add_content` applies when
  a credible active gap has a successful corpus check with no related document above
  the configured relevance floor; `investigate_retrieval` applies when relevant
  knowledge existed before the gap answers but those answers generally failed to
  retrieve or cite it; and `review_existing_content` applies when related knowledge was
  retrieved but insufficient, or was added/changed after the gap evidence and should
  be checked and retested. If corpus evidence is unavailable, the action MUST be
  unavailable rather than default to `add_content`.
- **FR-085**: In ranking version 1, a credible active gap MUST require a mature topic
  and reduced/no-support evidence from at least two distinct current-window
  conversations whose remediation evidence remains active under FR-030. Topics below
  that threshold remain visible as emerging or `monitor` evidence and MUST NOT receive
  an add/review/investigate action.

#### API and authorization

- **FR-044**: The system MUST expose one authorized Content plan summary/list read
  contract for the active workspace with a fixed `30d` range, a view of
  `opportunities` or `all_interests`, deterministic pagination, and freshness
  metadata.
- **FR-045**: The system MUST expose an authorized topic-detail contract containing
  the topic evidence, recommendation state, representative questions, affected agents
  and channels, and related documents without exposing embeddings or provider data.
- **FR-046**: The system MUST expose an authorized topic-member-turn read contract
  that reuses the existing Quality turn representation and conversation drill-down
  behavior for current-window, comparison-window, or both memberships.
- **FR-047**: Content plan reads MUST use the same workspace authorization level as
  existing Quality reads. Unknown and foreign topic identifiers MUST use the same
  not-found behavior to avoid existence disclosure.
- **FR-048**: Every list/detail response MUST include an `asOf` time, projection state,
  processed-through time, pending observation count, and embedding-space status so the
  client can explain freshness honestly.
- **FR-049**: Topic list cursors and shareable topic URLs MUST remain valid across
  normal topic enrichment. A merged topic identifier MUST redirect within the API
  contract to the surviving authorized topic.
- **FR-050**: Code-first OpenAPI, generated OpenAPI artifacts, TypeScript SDK types,
  generated MCP API types, contract tests, and public documentation MUST agree with
  the runtime contracts.
- **FR-051**: The feature MUST NOT add a create-report, refresh-report, report-job, or
  immutable-report endpoint.
- **FR-082**: Freshness metadata MUST separate `pendingEmbeddingCount`,
  `pendingAssignmentCount`, and `pendingEnrichmentTopicCount`; it MUST also expose
  `processingLagSeconds`, bootstrap/reprojection processed and total counts when
  applicable, and a typed projection state. A single ambiguous “pending” total is not
  sufficient.

#### UI Tasks

- **FR-052**: Activity navigation MUST add a distinct **Content plan** item alongside
  Needs attention, All activity, and Quality. Existing Quality health and answer queue
  MUST remain a focused answer-review experience rather than sit below the report.
- **FR-053**: The Content plan header MUST show “Last 30 days,” the comparison period,
  an accessible `as of` timestamp, and a quiet processing state. It MUST NOT show a
  Generate or Refresh report action.
- **FR-054**: The top summary MUST show visitor questions, mature topics, credible
  opportunities, and reduced/no-support rate with its evaluated-answer denominator.
- **FR-055**: When a credible recommendation exists, the page MUST show one prominent
  **Recommended next** card containing the topic, why it matters, evidence sample,
  questions to answer, and primary action. When none exists, the space MUST become an
  appropriate healthy, unmeasured, or more-evidence-needed state rather than an empty
  decorative card.
- **FR-056**: The default topic view MUST show Content opportunities. A secondary All
  interests view MUST reveal well-covered topics without making them look like work to
  do. Emerging questions MUST be a separate, quieter section.
- **FR-057**: Each mature topic row MUST communicate its label, short description,
  demand, trend, distinct-conversation sample, grounding composition, evidence
  strength, and recommendation state. Grounding composition MUST use text or accessible
  labels in addition to color.
- **FR-058**: Selecting a topic MUST update a shareable URL and open an evidence-first
  detail. Wide screens MUST preserve list context in a two-pane layout; narrow screens
  MUST present the same content as a full-width detail or sheet with an obvious back
  action.
- **FR-059**: Topic detail MUST order information as: decision/action, evidence and
  freshness, questions to answer, representative visitor questions, related documents,
  then affected agents/channels. Generated prose MUST not precede the evidence that
  qualifies it.
- **FR-060**: The detail actions MUST include only those supported by evidence: Write
  document or another add method, Review document, Investigate retrieval through the
  filtered answers, View answers, and Copy brief.
- **FR-061**: Write document MUST open the existing inline-document flow with a
  suggested title and a question-only outline. It MUST NOT prefill factual answers and
  MUST require normal operator review and save behavior.
- **FR-062**: View answers MUST open the existing Quality answer-review experience
  filtered by topic membership and MUST preserve a return path to the selected topic.
- **FR-063**: The frontend MUST provide deliberate skeleton/loading, bootstrap,
  no-traffic, no-opportunity, no-evaluated-grounding, low-volume, emerging, processing-
  delayed, partial-enrichment, embedding-reprojection, deleted-evidence, permission,
  and request-failure states.
- **FR-064**: Topic list, detail, segmented views, actions, coverage visualizations,
  drawers/sheets, and status announcements MUST be keyboard accessible, screen-reader
  understandable, usable without color, and robust to 200% zoom and narrow layouts.
- **FR-065**: Workspace changes and out-of-order requests MUST never show topics,
  questions, recommendations, or related documents from the previously active
  workspace.
- **FR-083**: Grounding composition MUST render only the three measured verdicts in
  its primary composition. `not_evaluated` MUST appear separately as an unmeasured
  count/annotation and MUST NOT look like a fourth grounding verdict or failure band.

#### Reliability, privacy, and observability

- **FR-066**: Projection claims, retries, and topic writes MUST be concurrency-safe and
  idempotent across multiple worker processes. An expired or duplicated claim MUST NOT
  publish stale enrichment over a newer topic revision.
- **FR-067**: Projection failures MUST use typed stages and bounded retries. Core
  evidence, prior coherent projections, and unrelated topics MUST remain readable when
  one observation or enrichment fails.
- **FR-068**: Privacy deletion MUST remove or anonymize retained question text,
  vectors, source identifiers, and memberships as required, then reconcile aggregates.
  Deleted content MUST NOT survive solely in a recommendation prompt cache or evidence
  excerpt.
- **FR-069**: Provider-bound question samples MUST be bounded, delimited as untrusted
  data, and limited to the minimum required representative evidence. Provider failure
  responses MUST NOT be copied into operator-visible detail or observability.
- **FR-070**: Structured logs MUST cover observation discovery, projection outcome,
  reconciliation, enrichment outcome, bootstrap, reprojection, and terminal failure
  using identifiers, counts, durations, and typed reasons only.
- **FR-071**: Metrics MUST include projection lag, pending observations, embedding reuse
  versus fallback, assignment outcomes, provisional/mature topic counts, merge count,
  enrichment latency/outcomes, provider call counts, and bootstrap/reprojection
  progress without raw content or high-cardinality question/topic labels.
- **FR-072**: Traces MUST correlate committed turns to observation projection and topic
  enrichment using safe identifiers while excluding question text, vectors, labels,
  recommendations, documents, prompts, and completions.
- **FR-073**: An operator opening a content plan or topic detail is an ordinary
  authorized read and does not require a new audit event. Any future write or export
  action is out of scope and must receive a separate audit review.
- **FR-084**: The projection MUST retain source identifiers, hashes, vectors, and
  membership rather than duplicate raw visitor questions. Representative text and
  enrichment samples MUST be fetched through authorized source-message reads when
  available; deletion of a source MUST make its text unavailable immediately and mark
  affected enrichment stale.

### API Direction

The first release adds three workspace-scoped reads using the existing dashboard
session or workspace bearer-token flow, protected by `workspace.quality.read`. The
Content Planning module owns their services even
though they share the existing `/quality` authorization namespace:

```text
GET /api/v1/quality/content-plan
    ?view=opportunities|all_interests
    &cursor=<opaque>&limit=<bounded>

GET /api/v1/quality/content-plan/topics/{topicId}

GET /api/v1/quality/content-plan/topics/{topicId}/turns
    ?window=current|comparison|both
    &page=<positive>&pageSize=<bounded>
```

There is deliberately no write, generation, refresh, or job-status endpoint.

The list response must be sufficient to render the header, summary, Recommended next
card, topic list, emerging section, and processing strip without an N+1 request per
topic. Its contract is:

```ts
interface ContentPlanPage {
  range: '30d'
  window: { from: string; to: string }
  comparisonWindow: { from: string; to: string }
  asOf: string
  projection: {
    state: 'bootstrapping' | 'ready' | 'updating' | 'delayed' | 'reprojecting' | 'degraded' | 'budget_paused'
    processedThrough: string | null
    processingLagSeconds: number | null
    pendingEmbeddingCount: number
    pendingAssignmentCount: number
    pendingEnrichmentTopicCount: number
    processedCount: number | null
    totalCount: number | null
    embeddingSpaceFingerprint: string | null
    reason: string | null
  }
  summary: {
    questionCount: number
    conversationCount: number
    matureTopicCount: number
    emergingQuestionCount: number
    opportunityCount: number
    grounding: {
      evaluatedAnswerCount: number
      groundedAnswerCount: number
      degradedAnswerCount: number
      noSupportAnswerCount: number
      notEvaluatedAnswerCount: number
      reducedOrNoSupportRate: number | null
      headlineState: 'measured' | 'insufficient_measured_turns' | 'unmeasured'
    }
  }
  rankingVersion: number
  recommendedTopicId: string | null
  items: ContentPlanTopicSummary[]
  emerging: ContentPlanEmergingQuestion[]
  nextCursor: string | null
}
```

Each mature topic summary contains its stable id, label/description state, demand and
trend, distinct-conversation sample, the three measured grounding-verdict counts, a
separate `notEvaluatedAnswerCount`, opportunity priority/reasons, deterministic action,
and enrichment status. The detail response adds bounded representative source-message
references, questions-to-answer brief, related documents, affected agents/channels,
and merge redirect metadata. It never returns vectors, raw provider fields, prompts,
or document excerpts.

The member-turn endpoint returns the existing paginated Quality turn representation.
Its population is the topic membership intersection with the requested report window;
it preserves the existing mapper, authorization, deletion behavior, and conversation
drawer inputs.

No MCP tool is added in the first release. Generated MCP OpenAPI types remain aligned
because the public OpenAPI surface changes. No document-worker or AMQP payload changes
are expected: continuous work is claimed from PostgreSQL by the existing backend
worker lifecycle, with retry policy finalized and documented during planning.

### Frontend Experience

The desktop hierarchy is intentionally decision-first and avoids a decorative chart
dashboard:

```text
Content plan                         Last 30 days · updated/as-of state
[Processing strip only when work is pending or delayed]

[Visitor questions] [Topics] [Opportunities] [Grounding gaps / measured basis]

Recommended next
┌ topic, why now, evidence sample, questions to answer, primary action ┐

[Content opportunities] [All interests]
┌ Ranked topics / emerging evidence ┬ Selected topic detail            ┐
│ demand · trend · support evidence │ action · evidence · brief        │
│ next topic                         │ questions · documents · sources  │
└────────────────────────────────────┴───────────────────────────────────┘
```

The Recommended next card is singular by design: the ranked list immediately below
keeps the runners-up visible without duplicating three summary cards. The primary
grounding composition shows `grounded`, `degraded`, and `no_support`; unmeasured
answers appear beside it as a separate annotation. Low-evidence summary tiles show raw
counts and “insufficient measured answers,” not alarming percentages.

At narrow widths the list becomes the page and topic selection opens a full-width
detail/sheet. Returning restores list position and focus. The screen must remain useful
without the detail open, and the detail must remain understandable when opened from a
shared URL without prior list context.

### Key Entities

- **Content Planning Observation**: One eligible, contextualized semantic information
  need derived from a committed visitor/assistant turn. It references the source user
  and assistant messages, a non-reversible semantic-text hash, semantic subquery
  identity, vector-space identity, answer-level grounding snapshot, and projection
  state. Raw question text remains message-owned and is fetched through authorized
  source reads only when needed. The observation's source identity is idempotent.
- **Content Topic**: A workspace-scoped persistent semantic cluster with a stable
  public identifier, lifecycle (`provisional`, `mature`, `merged`, `retired`), current
  embedding-space centroid, representative observations, and versioned enrichment
  state.
- **Topic Membership**: The assignment of one observation to one topic with assignment
  version and confidence. One source message may have several memberships only when it
  contains distinct semantic subqueries.
- **Topic Enrichment**: Versioned generated label, description, content brief, related-
  document evidence, action, and explicit state. It can fail or become stale without
  invalidating topic evidence.
- **Content Plan Projection State**: Workspace-level bootstrap/reprojection and
  freshness metadata: coherent `asOf`, processed-through time, pending count, active
  embedding space, and typed degradation reason.
- **Content Opportunity**: A mature topic whose current active reduced/no-support
  evidence makes it eligible for remediation ranking. It is a read-model role, not a
  separate mutable object.

### Assumptions And Dependencies

- Issue #938 / spec 873 provides durable answer-level grounding diagnostics for new
  and recoverable historical turns.
- Existing Quality population, triage state, and Eval verification remain the source
  of truth for inclusion and active remediation evidence.
- The fused/staged turn interpretation path can expose a structured interaction role
  and contextual semantic intent without adding a dedicated reporting model call.
- Retrieval can expose reusable query vectors and their complete embedding-space
  identity without changing search behavior.
- The existing dashboard is currently English-language; generated labels and briefs
  use the operator-facing dashboard language. Locale-aware enrichment storage must not
  be generalized beyond actual dashboard localization requirements in this release.
- The current inline Knowledge document flow can accept a topic identifier and use the
  authorized topic brief to prefill a title/question outline; raw visitor text is not
  placed in the URL.
- A mature-topic threshold of at least two semantically coherent observations from at
  least two conversations is the default to validate. Singletons remain visible under
  Emerging questions rather than disappear.
- Ranking thresholds, semantic distance, cohesion, material-change, and merge
  thresholds are evaluation parameters finalized during planning against the committed
  fixture; their resulting versioned behavior must be deterministic in production.
- No new external storage, browser analytics vendor, or cross-service AMQP payload is
  required. The existing backend worker process may host the bounded processor through
  application composition.
- Initial implementation updates operator and API documentation plus the Quality and
  frontend component briefs/code map if public ownership seams change.

## Explicitly Out Of Scope

- Scheduled, weekly, monthly, or manually generated report snapshots.
- Long-term analytics beyond the rolling current and comparison windows.
- Operator-created, renamed, pinned, split, or manually merged topics.
- Assignment, comments, approval workflow, notifications, alerts, exports, or shared
  content calendars.
- Automatic document publication, automatic factual drafting, or autonomous corpus
  changes.
- Automatic bulk triage resolution when content is added.
- Topic-level retrieval tuning or any feedback from report topics into assistant
  routing, retrieval, prompting, or answers.
- Claim-to-semantic-subquery grounding attribution; grounding remains answer-level.
- Automatic topic splitting in the first release.
- Cross-workspace or account-wide topic reports and agent/channel filters.
- A user-configurable report window, topic thresholds, or ranking weights.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In an operator usability walkthrough using realistic data, the operator
  can identify the recommended next content action, explain the evidence behind it,
  and begin the appropriate remediation in under two minutes without instruction.
- **SC-002**: One hundred percent of eligible committed turns with compatible reusable
  embeddings incur no additional embedding-provider request for those semantic
  intents.
- **SC-003**: Under normal worker availability, at least 95% of eligible committed
  turns appear in the coherent Content plan projection within two minutes, while
  durable observation registration adds no provider call and no more than 25 ms to
  p95 visitor-facing turn-completion latency under the documented reference load.
- **SC-004**: For every tested source population, report-wide distinct message counts,
  topic demand, current/comparison windows, and grounding categories reconcile exactly
  with the shared Quality semantics and documented multi-subquery counting rule.
- **SC-005**: No social/control message or clarification value in the multilingual
  reporting fixture creates an independent topic or grounding gap; every substantive
  contextual follow-up resolves to the expected standalone intent.
- **SC-006**: On a committed fixture of at least 160 questions spanning at least eight
  topics, three non-English languages, conversational fragments, paraphrases,
  multi-intent turns, unrelated questions, and prompt injection, mature-topic
  clustering achieves pairwise F1 of at least 0.85 overall and at least 0.80 for
  cross-language equivalence pairs.
- **SC-007**: Every ready observation is assigned once to a mature/provisional topic or
  has a typed pending/failure state; no observation silently disappears and duplicate
  processing never changes counts.
- **SC-008**: A new unmatched question becomes visible under Emerging questions within
  the normal projection target, and a second coherent cross-conversation question
  promotes it according to the versioned maturity rule without a full report rebuild.
- **SC-009**: A well-covered high-demand topic appears in All interests but never as a
  grounding-driven opportunity; an unevaluated topic never receives a grounding-gap
  rate or add-content action solely because diagnostics are absent.
- **SC-010**: The default Content opportunities view orders topics exactly according
  to the published ranking version, and the top credible topic matches the Recommended
  next card in every deterministic test case.
- **SC-011**: Topic-label, recommendation, related-document, fallback-embedding, and
  reprojection failures preserve the last coherent evidence and display the correct
  bounded UI state without fabricated labels, zeroes, or advice.
- **SC-012**: An authorized operator can move from topic to representative question,
  conversation, topic-filtered Quality answers, related document, and prefilled
  question-only document outline while retaining a valid return path.
- **SC-013**: Content plan list/detail and all specified empty/degraded states pass
  Playwright coverage at desktop and narrow viewport sizes, including keyboard-only
  navigation, visible focus, screen-reader labels, non-color status meaning, and 200%
  zoom without loss of primary actions.
- **SC-014**: Workspace isolation, deletion, and out-of-order request tests show zero
  cross-workspace topic/evidence leakage and no retained deleted question text or
  vectors outside the documented retention boundary.
- **SC-015**: Code-first OpenAPI runtime output, generated artifacts, SDK/MCP types,
  focused backend tests, frontend adapter tests, Playwright journeys, documentation,
  and local CI pass with no contract drift.
- **SC-016**: Logs, metrics, traces, and analytics contain no raw visitor question,
  vector, topic label, recommendation, document content, prompt, or completion in all
  covered success and failure paths.
- **SC-017**: The summary and every topic visualization render `not_evaluated` as a
  separate unmeasured annotation, never as a fourth verdict segment; fewer than five
  evaluated conversations produce raw counts plus `insufficient_measured_turns`
  instead of a percentage-only headline.
- **SC-018**: Deterministic fixtures cover all four recommendation actions: no credible
  gap produces `monitor`; a credible gap with no related content produces
  `add_content`; a credible gap with pre-existing relevant content that was generally
  missed produces `investigate_retrieval`; and retrieved-insufficient or newly changed
  related content produces `review_existing_content`. Unavailable corpus analysis
  produces no action.
- **SC-019**: Prompt-injection instructions embedded in representative questions in
  every fixture language cannot change the structured output shape, cause tool use,
  introduce unsupported factual claims, select an action contrary to deterministic
  corpus evidence, or expose hidden prompt/context data.
- **SC-020**: Expired/deleted zero-member provisional topics disappear, and merged
  topic links resolve transitively to the surviving authorized topic for at least 90
  days without redirect loops or cross-workspace disclosure.
- **SC-021**: Under the documented reference dataset of 20,000 eligible semantic
  observations across the active 60-day horizon, an authorized operator sees the
  coherent summary and first page of topics within two seconds for at least 95% of
  requests.
