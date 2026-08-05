# Feature Specification: Audience Topic Census

**Feature Branch**: `956-audience-topic-census`
**Created**: 2026-08-03
**Status**: Draft
**Source**: Coverage analysis of the shipped Audience Pulse
(`specs/939-continuous-content-planning`). Replaces sampled theme discovery
with a topic census over every visitor question in the window.

## Goal

Give a workspace operator a topic distribution they can trust and track:

1. What share of visitor questions falls into each topic, over **all**
   questions in the window rather than a sample of them?
2. Is a given topic growing or shrinking, answered across successive
   analyses of the same workspace?
3. Which topics lacked grounded support, measured against real topic size?

Audience Pulse already answers "what are visitors talking about" well
qualitatively. Its theme labels are good. This feature keeps the labels and
replaces the counting.

## Existing Behavior And Feature Delta

Audience Pulse selects at most 80 questions per analysis
(`AUDIENCE_PULSE_SAMPLE_MAX_QUESTIONS`, `backend/src/modules/audiencePulse/
contracts.ts:28`), passes them to one model call bounded at 8,000 prompt
tokens (`services/prompt.ts:11-13`), and asks the model to group the supplied
evidence IDs into at most eight named themes. All numbers are then computed
in application code from the model's grouping.

Three defects follow from that design.

**The estimator is biased at any sample size.** `selectAudiencePulseSample`
(`backend/src/modules/chat/audiencePulseHistorySource.ts:132-153`)
round-robins across `(UTC week, source_channel)` strata, giving each stratum
roughly equal allocation regardless of its true size. Nothing reweights on
the way out: `sampleCount` is `items.length` (`domain/report.ts:239`). A week
carrying 100 questions and a week carrying 20 contribute a similar number of
sampled items, so theme sizes partly measure the sampler. Raising the cap
does not correct this.

**Coverage decays with volume.** The 80 is absolute, and it is bounded by the
prompt budget rather than by anything about the data. An observed workspace
reads 80 of 242 questions. The same workspace at 2,400 questions per month
would still read 80.

**Sample counts are presented as frequencies.** The dashboard renders
`asked {theme.sampleCount}×` (`frontend/components/dashboard/
audience-pulse-view.tsx:619`), which understates real frequency by the
inverse of the coverage ratio. `theme.weeklyPulse` (`domain/report.ts:149-161`)
buckets sampled evidence by week and is flattened by the same equal
allocation; it is persisted and typed but not yet rendered.

The delta: extract a normalized topical facet from every eligible question
once, embed the facet, cluster the whole population, and use the model only
to name clusters. Counts become exact. Coverage becomes total. Topic
identity persists across analyses.

## Product Decision

- Topic membership is computed from stored facets and embeddings. The model
  names and describes topics; it never partitions the population and is
  never the source of a displayed count. This extends the rule already in
  `specs/939-continuous-content-planning` that SQL supplies exact metrics.
- Facet extraction runs asynchronously per message, not during analysis. A
  question's facet is computed once and reused by every later analysis.
- Topics carry stable identifiers across analyses. When a topic survives a
  re-clustering it keeps its identifier and its operator-visible label.
- The stored facet is a short, PII-stripped, language-normalized description
  of what was asked. Raw question text remains unpersisted in pulse
  artifacts, as it is today.
- Clustering is deterministic. Two analyses over identical inputs produce
  identical topics, sizes, and identifiers.
- The clustering pipeline lives in `@radioso/census`, structured like
  `typescript-sdk/`: its own build, tests, and `package.json`, and **zero
  runtime dependencies**. A package that depends on nothing cannot acquire a
  provider SDK or a database client by accident, which makes the boundary a
  property the build checks rather than a convention reviewers enforce. The
  package stays private to this workspace under this spec.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Trustworthy topic distribution (Priority: P1)

An operator opens Audience Pulse for a workspace with 242 visitor questions
in the last 30 days. Every question is accounted for: each topic shows how
many questions it holds and what share of the window that is, and the totals
reconcile to the window total.

**Why this priority**: This is the defect. Until counts are exact and
complete, every downstream judgement an operator makes from this page rests
on a biased sample.

**Independent Test**: Seed a workspace with a known question distribution
where one topic is deliberately concentrated in a single high-volume week.
Run an analysis. Assert that the reported topic sizes match the seeded
distribution within the clustering tolerance, and that the sum of topic
sizes plus unclassified equals the window total.

**Acceptance Scenarios**:

1. **Given** a workspace with 242 eligible questions in the window, **When**
   an operator runs an analysis, **Then** the coverage line states that all
   242 questions were read.
2. **Given** a completed analysis, **When** topic sizes and the unclassified
   count are summed, **Then** the total equals the window question count.
3. **Given** a topic concentrated in the busiest week of the window, **When**
   the analysis completes, **Then** that topic's size reflects its true
   share rather than an equal-allocation share.
4. **Given** a workspace whose questions arrive in more than one language,
   **When** the analysis completes, **Then** questions asking the same thing
   in different languages fall into one topic.

---

### User Story 2 - Track a topic over time (Priority: P2)

An operator ran an analysis three weeks ago and runs another today. Topics
that persisted keep their names and identifiers, so the operator can see
which grew, which shrank, and which are new.

**Why this priority**: The census is useful without it — a monthly digest
reads perfectly well as a standalone snapshot of what visitors asked about.
Identity is what later makes trends expressible, and it is cheap enough to
build alongside the clustering rather than retrofit.

**Independent Test**: Run two analyses over overlapping windows on a
workspace whose traffic mix shifts. Assert that unchanged topics keep their
identifiers and labels, that a topic absent from the second run is reported
as dissolved, and that a topic present only in the second run is reported as
emerged.

**Acceptance Scenarios**:

1. **Given** two successive analyses where a topic's membership is largely
   unchanged, **When** the second completes, **Then** that topic keeps its
   identifier and its label.
2. **Given** a topic that splits into two distinguishable topics, **When**
   the analysis completes, **Then** the result records a split from the
   prior identifier and both descendants carry new labels.
3. **Given** a topic with no counterpart in the new analysis, **When** the
   analysis completes, **Then** it is recorded as dissolved rather than
   silently disappearing.

---

### User Story 3 - Work is never repeated (Priority: P3)

An operator refreshes the analysis. Facets and embeddings computed for
earlier analyses are reused, and topics that survived unchanged keep their
existing labels without another naming call.

**Why this priority**: The feature is correct without it. It matters for
label stability more than for cost — a topic whose description is reworded
on every refresh reads as churn to an operator watching a digest.

**Independent Test**: Run an analysis, re-run it with no new questions.
Assert that no extraction call and no naming call is issued.

**Acceptance Scenarios**:

1. **Given** a message whose facet already exists at the current prompt
   version, **When** an analysis runs, **Then** no extraction call is issued
   for that message.
2. **Given** an analysis where every topic survives, **When** it completes,
   **Then** no naming call is issued and every label is unchanged.

### Edge Cases

- A workspace with fewer questions than the minimum viable topic size. The
  analysis reports the questions as unclassified rather than inventing
  topics from noise.
- A workspace where every question is near-identical. Clustering yields one
  topic; the result must not be a degenerate set of arbitrary splits.
- A question whose facet extraction fails or returns empty. The question is
  counted in the window total and reported as unclassified, never dropped
  from the denominator.
- A workspace that changes embedding profile. Stored facet embeddings become
  incomparable and must be re-embedded before the next analysis; facets
  themselves survive, because they are text.
- The facet extraction prompt changes. Facets carry the prompt version that
  produced them; a version change triggers re-extraction rather than mixing
  incompatible facets in one space.
- A topic that is large but entirely ungrounded. Content-gap signalling must
  scale with real topic size rather than sampled size.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- User-facing assistant or chat responses MUST NOT rely on hard-coded application strings; runtime conversational copy MUST be generated by the LLM so multilingual behavior remains intact.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit tests MUST stay focused on non-visual logic rather than markup or design assertions.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: `@radioso/census` is a topic-analytics library. It takes
  texts, an embedding function, and a naming function, and returns named
  clusters with identities. The test for whether something belongs in it: a
  question about *topics over texts* is in scope; a question about visitors,
  grounding, content gaps, routines, digests, or reports is a Radioso product
  judgement and stays out. `backend/src/modules/audiencePulse/` owns those —
  which questions are eligible, what a topic means to an operator, how a
  report is shaped. `backend/src/modules/chat/` owns reading conversation
  history. Persistence stays in `backend/src/db/repositories/`.
- **Encapsulation Rule**: `audiencePulseHistorySource.ts` must stay a history
  reader. It must not acquire clustering, facet extraction, or topic
  identity logic. `@radioso/census` must not acquire a database
  handle, a provider SDK, or a Radioso type.
- **New Seams Required**:
  - `@radioso/census` — pure clustering and identity matching over
    `(id, text, vector)` triples. Zero runtime dependencies, own build and
    test setup, laid out like `typescript-sdk/`.
  - A facet extraction worker job, dispatched on the existing document
    worker spine rather than inline in a request.
  - A facet store keyed by message, carrying facet text, embedding, prompt
    version, and embedding profile.
  - A topic store carrying stable identifiers, centroids, labels, and
    transition history across analyses.
- **Anti-Goals**:
  - Do not put clustering in the audience pulse service.
  - Do not let the model partition the population; it names clusters only.
  - Do not persist raw question text in the facet store.
  - Do not introduce UMAP or a density-based clusterer to gain
    non-determinism the dashboard cannot use.
  - Do not resolve the coverage problem by raising the sample cap.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST extract exactly one facet per eligible visitor
  question, asynchronously, and reuse it for every subsequent analysis.
- **FR-002**: System MUST record the facet prompt version and embedding
  profile alongside each facet, and MUST treat facets produced under a
  different version as requiring re-extraction.
- **FR-003**: System MUST cluster over the full set of eligible questions in
  the analysis window, not a sample.
- **FR-004**: System MUST produce identical topics, sizes, and identifiers
  for two analyses over identical input.
- **FR-005**: System MUST report every eligible question as either a member
  of exactly one topic or as unclassified, with the two summing to the
  window total.
- **FR-006**: System MUST assign a stable identifier to each topic and
  preserve it across analyses when the topic survives.
- **FR-007**: System MUST classify each topic transition between analyses as
  survived, merged, split, emerged, or dissolved.
- **FR-008**: System MUST reuse an existing topic's label when the topic
  survives unchanged, and MUST issue a naming call only for topics that
  emerged, merged, or split.
- **FR-009**: System MUST generate topic labels and descriptions through the
  LLM rather than from keyword extraction or hard-coded vocabulary.
- **FR-010**: System MUST report topic size as an exact count and share of
  the window, and MUST NOT present a sampled count as a frequency.
- **FR-011**: System MUST compute per-topic weekly volume from population
  membership rather than from sampled evidence.
- **FR-012**: System MUST scale content-gap eligibility thresholds against
  real topic size.
- **FR-013**: System MUST exclude a question from topic membership when its
  facet is missing or extraction failed, while retaining it in the window
  total as unclassified.
- **FR-014**: `@radioso/census` MUST accept only precomputed
  `(id, text, vector)` triples and deterministic options as data input. It
  MUST NOT accept or call embedding, naming, audit, or other model functions;
  callers own embedding and label generation outside the package.
- **FR-015**: `@radioso/census` MUST declare zero runtime dependencies, and
  CI MUST fail when its `dependencies` block is non-empty or when its source
  imports anything outside Node built-ins and its own modules. Enforcement
  extends `scripts/validate-architecture-boundaries.mjs`.
- **FR-016**: Reweighting the existing sampled report ships as a separate
  change ahead of this feature, so the live dashboard stops reporting biased
  shares while the census is built.

### Key Entities

- **Question Facet**: One per eligible visitor message. Holds the normalized
  facet text, its embedding, the prompt version that produced it, the
  embedding profile it was embedded under, and the source message reference.
  Holds no raw question text.
- **Topic**: A workspace-scoped, persistent named cluster. Holds a stable
  identifier, centroid, operator-visible label and description, the analysis
  that created it, and the analysis that last confirmed it.
- **Topic Membership**: The assignment of a question facet to a topic for a
  given analysis, carrying the distance that justified it.
- **Topic Transition**: The relationship between a topic in one analysis and
  its counterparts in the next — survived, merged, split, emerged, or
  dissolved — with the prior identifiers involved.
- **Analysis Run**: One census over a window. Holds the window bounds, the
  question count, the clustering parameters and seed, and the resulting
  topic set.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An analysis reports coverage of 100% of eligible questions in
  its window, at every workspace volume.
- **SC-002**: Topic sizes reported for a seeded distribution match the true
  distribution, with no systematic flattening across weeks or channels.
- **SC-003**: Two analyses over identical input produce byte-identical topic
  identifiers, sizes, and membership.
- **SC-004**: Across two analyses of a workspace whose traffic mix is
  unchanged, every topic survives with its identifier and label intact.
- **SC-005**: A repeat analysis with no new questions issues zero facet
  extraction calls and zero naming calls.
- **SC-006**: A full analysis over a 12-month window at current traffic
  (order 12,000 questions) completes inside the existing refresh timeout with
  warm facets, so widening the window stays a product choice rather than a
  performance question.
- **SC-007**: No pulse artifact persists raw visitor question text.
- **SC-008**: Questions asked in different languages with the same intent
  land in a single topic in a seeded multilingual fixture.

## Message-Queue Impact Review

Facet extraction is a new worker job. It needs a dispatch path on the
existing document worker spine, a payload contract, retry semantics for
provider failures, and a dead-letter path for questions whose extraction
fails repeatedly. Queue documentation and contract tests need updating
alongside. Re-extraction triggered by a prompt version change is a bulk
enqueue and needs a rate that does not starve document processing.

## Observability Review

New runtime paths that need coverage: facet extraction outcome per message
(succeeded, failed, skipped as ineligible), extraction latency, analysis
duration split between clustering and naming, count of naming calls issued
versus topics reused, clustering iteration count and final inertia, and
counts of each topic transition type per analysis. Operator-relevant
degradations to surface: facet backlog depth, unclassified share rising
above a threshold, and re-embedding required after an embedding profile
change.

Observability output carries identifiers, counts, and durations. It must not
carry facet text, question text, labels, or embeddings.

## Documentation Impact

The operator-facing Audience Pulse documentation needs to describe topics as
a census rather than a sample, and to explain topic identity across
analyses. `docs/architecture/code-map.md` needs its Audience Pulse section
updated with the new package, worker job, and stores, plus a `Related specs`
pointer here. When the feature ships, the algorithm writeup in this spec
directory graduates to `docs/architecture/` describing what exists.

## Assumptions And Dependencies

- The workspace embedding profile is available for embedding short facet
  text through `ClusteringEmbeddingPort`.
- Facet extraction runs on the cheap `"rewrite"` tier. This was the primary
  technical risk and has been measured against 318 real questions from the
  Ananda Europe workspace; see `eval-calibration.md`. The result is narrower
  than the original assumption:

  Facets make one intent land in one cluster regardless of the language it
  was asked in — cross-lingual cohesion 1.000 against 0.571 for raw-question
  embeddings, and multilingual ARI 0.702 against 0.451. That claim holds, and
  it matters here because 61% of this workspace's traffic is not English.

  Facets do **not** demonstrably improve overall topic recovery. Scored
  against two independent reference labellings of the same questions, facets
  win against one (ARI 0.219 versus 0.181) and lose against the other (0.186
  versus 0.271). The feature is therefore justified by cross-lingual
  normalization alone, and a workspace whose traffic is monolingual would not
  see the same benefit.
- Question eligibility rules stay as they are today: visitor-role messages,
  customer or null source, excluding operator test channels.
- Current traffic is order 1,000 visitor questions per month across all
  workspaces. Every analysis re-clusters its window from scratch, which is
  well inside budget at this volume and stays so for a 12-month window. The
  incremental-assignment machinery that high-volume deployments need is
  deliberately absent; `algorithm.md` records the threshold at which it
  becomes necessary.

## Explicitly Out Of Scope

- Publishing `@radioso/census` to a public registry.
- Operator editing of topic labels or manual merging of topics.
- Topic analysis over anything other than visitor questions.
- Replacing the recommendation and content-gap sections of the report, which
  keep their current shape and consume the new counts.
- Cross-workspace topic comparison.
