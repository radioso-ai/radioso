---
title: "Topic Census"
description: "How Audience Pulse computes an exact, deterministic topic distribution over visitor questions and tracks topic identity across analyses."
last_updated: 2026-11-19
---

# Topic Census

Every eligible visitor question in an analysis window counts toward exactly
one topic or the unclassified total. The count is exact: a whole-population
clustering computed from scratch for the window, not a projection from a
subset. Because the pipeline tracks which topic is which from one analysis to
the next, a topic can grow, shrink, split into two, absorb another, or
disappear and come back — and the report records which of those happened, not
just two snapshots that leave the reader to guess. The dashboard turns that
record into plain words: a topic row reads **new** when the topic emerged
since the previous analysis, and **up from N** or **down from N** when an
exactly matched topic's count and share both moved materially. Topics that
disappeared are listed under the topic rows.

The work runs in Postgres and the workspace's own model tiers. `@radioso/census`
(`packages/census`), the clustering and identity-matching library it depends
on, has no I/O of its own — it takes plain data in and returns plain data out.

## Pipeline

Two stages run once per message, in the background worker, and never repeat.
Three run once per analysis, over the whole window:

```
question ──▶ facet ──▶ vector          (per message, once)
                        │
                        ▼
                     cluster ──▶ name ──▶ match to prior topics
                                             (per analysis)
```

The model appears in exactly two places, and in neither does it decide who
belongs to which topic: it writes a facet for one question, and a title for
one cluster. Membership itself is arithmetic — k-means and the containment
scores that follow it.

## Facets

A facet is a short, neutral restatement of what a question asks, with
identifying detail stripped: "Dove siete?" and "Where are you located?" both
normalize to the same statement about asking for the organization's physical
location. Normalizing through a model that reads both languages puts
same-intent questions in the same place before any vector arithmetic runs,
which is what makes topics cohere across languages rather than by surface
phrasing.

`FacetExtractionService` (`backend/src/modules/facets/`) extracts one facet
per eligible message on the cheap `"rewrite"` model tier and stores it on
`message_facets`, alongside the prompt version that produced it and the
embedding profile used to embed it. A prompt version change invalidates a
facet rather than mixing generations in the same clustering space; a
`message_facets` row whose `prompt_version` does not match the current
version is excluded from clustering and counted as unclassified instead.

Extraction is dispatched from a durable job queue, `facet_extraction_jobs`,
one row per message, claimed through the shared background-job runtime
(`FacetExtractionBackgroundJobStore`) rather than a request-triggered call —
no chat turn, retrieval call, or dashboard load waits on it.

## Embedding

Facets are embedded through `ClusteringEmbeddingPort`, the same seam used for
document embeddings but bound to the clustering space rather than the
workspace's retrieval profile — the two do not need to share a model or a
dimension count. `message_facets.embedding` is a typeless pgvector column
that stores whatever width the active embedding profile produces, alongside
the profile id it was embedded under; a profile change invalidates stored
vectors, which are then re-embedded from the retained facet text at no extra
model cost.

## Clustering

`computeCensus` (`@radioso/census`) runs seeded k-means over unit-normalized
facet vectors under cosine distance, twice: once over all facets to produce
fine-grained base clusters, and once more over the base centroids to
agglomerate them into `topicTarget` operator-visible topics. A topic's members
are the union of the members of the base clusters it absorbed.

The library takes `topicTarget` as an option and defaults it to 10. The
Audience Pulse census service sets it from the number of facet-ready questions
it clusters, `n`: the square root of `n` divided by 3.5, rounded, and held
between 10 and 40 topics (`deriveTopicTarget`). A workspace with 1,350
questions or fewer gets 10 topics, one with 5,000 gets 20, and one with 14,000
gets 34. Topic count follows the square root of volume because a busy workspace
asks about more things, not proportionally more of them; the scaling keeps
topics narrow enough to act on as traffic grows. A base pass that yields no
more clusters than the target skips the agglomeration pass.

`k` for the base pass is derived from a target average cluster size —
`clamp(ceil(n / targetMembers), kMin, kMax)`, with `targetMembers` defaulting
to 20, `kMin` to 2, and `kMax` to 240 — rather than picked directly. Each
k-means call runs `restarts` independent attempts (5 by default, up to
`maxIterations` of 50 each) and keeps the lowest-inertia result.

Every run derives its PRNG seed by hashing the workspace id, the window
bounds, and the sorted set of facet ids actually going into clustering
(`deriveCensusSeed`). Identical input therefore produces byte-identical
output on any platform, and a changed input — one newly extracted facet, one
re-embedding — correctly changes the result. `@radioso/census` has zero
runtime dependencies; embedding and naming are always the caller's job,
passed in as data or as functions.

## Unclassified

k-means assigns every point to some cluster, so "unclassified" needs its own
rule. Two apply:

- **Distance.** Each cluster learns a radius from its own members — the 90th
  percentile of member-to-centroid distance. A member beyond
  `radius * marginFactor` (1.5 by default) is reported unclassified instead
  of stretching the cluster to include it.
- **Size.** A cluster below `minClusterSize` (3 by default) is not a topic;
  its members are unclassified.

A question whose facet is missing, stale, or not yet embedded is also
unclassified — it still counts toward the population, just not toward any
topic. The unclassified share is a finding in its own right: it locates
demand that no current topic captures.

## Naming and privacy review

A cluster that inherited its identity from a prior topic (see below) keeps
that topic's stored title and description and triggers no model call. Every
other cluster is named once, from exemplar facets: the six members nearest
the centroid, which show what the cluster is about, and the four members
farthest from it while still inside the cluster, which show how wide it is
(`buildTopicNamingPrompt`, `backend/prompts/audience-pulse-topic-naming.md`).

The generated label then passes a privacy review
(`backend/prompts/audience-pulse-topic-audit.md`): a model reads the title
and description on their own, with no facet text, and flags identifying
detail about a specific private individual. A flagged label is regenerated
once from the same exemplars; if the regeneration is also flagged, the topic
renders with a neutral fallback label
(`backend/prompts/audience-pulse-topic-fallback.md`) that carries no
cluster-specific content. The rejection itself is recorded in telemetry —
never the rejected text.

Each newly named topic costs two model calls, one to name it and one to
review the label. A flagged label adds a regeneration and a second review, and
a second flag adds the fallback call, for five at most. Calls are made per
topic and are not batched; a run starts every topic's calls concurrently.
Survived topics cost nothing, so a run's naming cost follows how many topics
changed identity, not how many topics exist.

## Topic identity across analyses

Clusters are anonymous — nothing in a clustering run says that this run's
third cluster is last run's seventh. `matchTopicIdentities` carries identity
forward by comparing the new clusters against the workspace's active topics
and classifying each relationship:

- **Survived** — one new cluster and one prior topic contain most of each
  other (both containments above `tauSurvive`, 0.5 by default). The cluster
  inherits the topic's id and label; no naming call runs.
- **Split** — one prior topic's members land across several new clusters,
  each above `tauPart` (0.3 by default). Each descendant gets a new id
  recording the prior topic as parent, and is named.
- **Merged** — several prior topics' members land in one new cluster above
  `tauPart`. The cluster gets a new id recording every parent, and is named.
- **Emerged** — a new cluster matching no prior topic. New id, named.
- **Dissolved** — a prior topic matching no new cluster. Recorded, never
  deleted, so a topic that returns later is recognizable as the same one.

Matching is resolved as maximum-weight bipartite matching over containment
scores, restricted to pairs above threshold, so ambiguity between several
plausible pairings has one deterministic answer. When two analyses share no
members at all — non-overlapping windows — containment is undefined and
matching falls back to cosine similarity between stored centroids, at a
stricter threshold (`tauCentroid`, 0.85 by default) than the containment
thresholds. `topic_transitions.via_centroid_fallback` marks a transition
decided this way, since centroid drift can happen for reasons unrelated to
topic identity.

## Storage

`CensusService.run` (`backend/src/modules/audiencePulse/services/censusService.ts`)
is the entry point: given a workspace and a window, it resolves the eligible
question population, loads the facets already extracted for it and the
workspace's matchable topics, including retained dissolved topics, clusters,
matches identity, names, and persists
the result in one transaction across:

- `topic_census_runs` — one row per analysis: the window, the exact question
  count, the unclassified count, the derived seed, and the clustering
  parameters used (`params_json`, which includes the `topicTarget` the run
  chose).
- `topics` — the current registry of topics, each with its centroid, radius,
  title, description, the run it was created in, and the run it was last
  seen in. A dissolved topic keeps its row, marked with `dissolved_at`.
- `topic_memberships` — which questions belonged to which topic on which
  run, with each member's distance to the topic centroid.
- `topic_transitions` — the classified relationship (survived, split,
  merged, emerged, dissolved) between each topic and each run. A unique index
  on `(run_id, topic_id)` keeps each run's classification singular.
- `message_facets` and `facet_extraction_jobs` — the per-message facet text,
  embedding, and extraction job state described above.

Embedding columns on `topics` and `message_facets` are typeless pgvector
columns, matching the `chunk_embeddings` convention: facet and centroid width
follow the workspace's active embedding profile. Neither table carries an
HNSW or IVFFlat index, because the census never performs a nearest-neighbour
search — a run reads its whole window into memory and clusters there.
Run hydration groups memberships by the topic primary key, so Postgres never
compares centroids from workspaces or historical profiles with different
embedding widths.

Each member-bearing topic in a census run carries its recorded transition,
including parent topic ids and the centroid-fallback signal, into the Audience
Pulse report. Run reads expose topics dissolved by that run in a separate
`dissolvedTopics` collection containing only the stable id and title. A
dissolved topic has no membership in that run, so the report assigns it no
member count. It stays available to identity matching, while only a topic that
is active at the start of a run receives a dissolved transition. Later runs
that still find no counterpart leave its original dissolution unchanged.

Audience Pulse compares a fresh census with the latest saved report when it
decides whether to reuse summary and recommendation copy. The comparison uses
the prior snapshot regardless of where the previous and current analysis-window
boundaries fall. The snapshot's stored census run id also matches the single
prior run whose memberships supply the current overlap measurement. Reuse
requires a fully facet-ready run with at least one topic,
a saved summary, and shared-membership survival for every current topic. Each
current topic's membership overlap with its prior run is more than 80 percent.
No topic dissolves or relies on centroid fallback. The ordered ids of the 8
richest topics shown to the narrative model are identical to the prior report's
ordered top eight, so a topic entering the narrative cap always regenerates its
recommendation.

Count, share, population, and unclassified drift becomes material when the
relative movement reaches 20 percent and the underlying count moves by at least
3 questions. The absolute floor treats one- and two-question changes as
integer noise in small topics. The report publishes the exact relative threshold
used for its decision as `narrativeReuseMaxDrift`, so clients render the backend's
rule instead of maintaining another constant.

The current content-gap theme-id set also matches the saved report. Every
evidence id stored on a saved theme remains a member of that same topic, and
the stored recommendation evidence exactly matches the current selector's
ordered output for its topic. Every selected id remains a current,
content-gap-eligible member of that topic. Missing, expired, moved, ineligible,
reordered, or newly selected evidence regenerates the narrative. A saved report
without an unclassified question count or topic share also regenerates it. A
narrative is reused for at most 3 consecutive refreshes; the following
refresh regenerates it.
`narrativeGeneratedAt` records when the current prose is generated, and
`narrativeReuseCount` records how many consecutive refreshes reuse it. Reports
without a persisted `dissolvedTopics` field read it as an empty collection, and
reports without `narrativeReuseMaxDrift` read the current 20 percent value.

The census-derived report is computed once per refresh. Regeneration applies
model-authored summary, recommendation copy, and caveats to that computation;
current content-gap qualification and current per-topic evidence remain the
source of recommendation membership. Reuse applies saved narrative copy to the
same fresh computation. Themes, counts, shares, weekly pulse, grounding, and
content gaps therefore always derive from the fresh census.

Usage accounting reserves an answer before the census because naming can call a
model before the narrative reuse decision exists. Reuse releases that reservation
when no model call is issued. A facet-not-ready refresh also releases its
reservation when no model call is issued. Once naming or narrative work is
dispatched, the refresh commits the reservation even when later model,
validation, or persistence work fails. Successful billable work commits before
snapshot persistence.

Census membership-integrity failures return the `census` unavailability reason
and record the same outcome in refresh audit metadata. Model response failures
use the separate `validation` reason.

## Report counts and the content queue

Beside its topics, a refresh counts the whole window with the same
per-question answer status the topic rows use. `totals` holds every eligible
question by answer status, the distinct conversations they came from, and how
many had no answer in the workspace's content, with an `unclassified` block
for the questions no topic claimed. Each topic's own counts plus that block
add up to the totals, bucket by bucket. `dailyVolume` has one entry per UTC
day the window touches, zero-filled, and `channels` counts by the
conversation's source channel, the largest first. A report still waiting on
facets carries all three, with every question unclassified.

`previousPeriod` counts the 30 days before the window by the same rule, read
through the history source's `readPeriodTotals`, which classifies each
question and keeps only the counts. The read roughly doubles a refresh's
per-question reads, so it logs `audience_pulse_previous_period_read` once per
refresh with the question count and duration. When those 30 days had no
eligible question, `previousPeriod` is null. `previousGeneratedAt` names the
saved report each topic's `previousMemberCount` and `previousShare` come from.
Reports saved before these fields existed return without them.

The content queue keeps operator state apart from the snapshot, which a
refresh overwrites. `PUT /api/v1/quality/audience-pulse/topics/:topicId/dismissal`
marks a topic "not for us" in `audience_pulse_topic_dismissals`, and `DELETE`
on the same path restores it; both need `workspace.quality.manage`. A
dismissal changes no count. `POST /api/v1/quality/audience-pulse/topics/:topicId/drafts`
with `{ "documentId": "…" }` records a document drafted from the topic in
`audience_pulse_topic_drafts` and needs both `workspace.quality.manage` and
`workspace.documents.manage`. Every
read joins this state onto each content gap as `dismissedAt` and
`latestDraft`. A surviving topic keeps its id across runs, so its state
carries from one refresh to the next. Deleting the topic, the document, or the
workspace deletes the rows, and each change that took effect writes an
`audience_pulse.topic_dismissed`, `audience_pulse.topic_restored`, or
`audience_pulse.topic_draft_linked` audit event.

## Backfill

`backend/scripts/dev/backfillFacetExtractionJobs.ts` enqueues facet
extraction jobs for a workspace's eligible visitor questions that predate
facet extraction running on every turn. It reuses the same eligibility rule
and the same idempotent `enqueue` the live turn path uses, reports newly
enqueued questions separately from ones that already had a job, and
processes ids in small, delayed batches so a large backfill cannot compete
with document processing for database connections.

## Related

- [Code Map: Audience Pulse](./code-map.md#audience-pulse)
- [Code Map: Facet Extraction Jobs](./code-map.md#facet-extraction-jobs)
- [Code Map: Topic Census Clustering](./code-map.md#topic-census-clustering-radiosocensus)
- `specs/956-audience-topic-census/algorithm.md` — the full design record,
  including which parts of this pipeline come from prior clustering
  literature and which are local engineering choices
