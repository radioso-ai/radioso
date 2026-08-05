# Algorithm: Audience Topic Census

**Spec**: `specs/956-audience-topic-census/spec.md`
**Created**: 2026-08-03
**Status**: Draft

This describes how to compute an exact topic distribution over every visitor
question in a window, with topic identities that persist across analyses. It
covers the five pipeline stages, the identity-matching step that makes topics
trackable, how membership and outliers are decided, and the parameters that
belong in typed configuration rather than as constants buried in code.

The design target is a background job that re-clusters its whole window from
scratch in seconds, produces the same answer twice given the same input, and
issues model calls proportional to the number of topics rather than the
number of questions. Current traffic is around 1,000 visitor questions per
month, which is small enough that several techniques the literature treats as
essential are left out on purpose; Scale says where that stops being true.

## Why the sample cannot be repaired

The current sampler round-robins across `(week, channel)` strata, which is a
defensible allocation, and then counts the result without weights, which is
not. In survey terms it uses disproportionate allocation with an unweighted
estimator, so stratum size cancels out of the answer. A week holding 100
questions and a week holding 20 contribute a similar number of sampled items
until the smaller queue drains.

Two repairs are available. Reweighting each sampled question by
`stratum_population / stratum_sample` restores unbiased shares and is a small
change — it needs `source_channel_key` added to the aggregate `groupBy`,
which today groups by week only. That fixes bias but leaves coverage decaying
as volume grows, and leaves the taxonomy itself derived from 80 questions.

The second repair removes the sample. It costs more to build and is the
subject of this document. The two are compatible: reweighting is worth
landing on its own if the census is more than a few weeks out, since the
dashboard is reporting biased shares in the meantime.

## Pipeline

Five stages. The first two run per message and never repeat; the last three
run per analysis.

```
question ──▶ facet ──▶ vector          (per message, once, in the worker)
                        │
                        ▼
                     cluster ──▶ name ──▶ match to prior topics
                                             (per analysis)
```

The critical property is that the model appears twice and in neither place
does it partition the population. It writes a facet for one question, and it
writes a label for one cluster. Membership is arithmetic.

## Facet extraction

A facet is a short, normalized statement of what a question asks, stripped of
identifying detail. "Dove siete?" and "Where are you located?" both become
something like *asking for the physical location of the organization*.

This stage carries most of the design weight, for three reasons.

**It collapses language.** Cross-lingual embedding alignment is imperfect and
varies by model; normalizing through a model that understands both languages
puts the two questions in the same place before any vector arithmetic
happens. Relying instead on a cross-lingual embedding model, or on a
downstream merge pass to reunite language-split clusters, both work less well
and cost more.

**It collapses surface form.** Short queries embed largely by lexical
overlap, so raw questions cluster by phrasing — every question starting
"where" drifts together regardless of subject. Facets are uniform in register
and length, which makes cosine distance mean something and makes a distance
threshold calibratable.

**It is more storable than the question.** A PII-stripped facet can be
persisted where raw visitor text cannot, which keeps the census consistent
with the existing rule that pulse artifacts hold no question text.

Extraction runs on a cheap model tier with structured output, one call per
eligible message, dispatched on the worker spine. The stored record carries
the facet text, the prompt version that produced it, and the embedding
profile used. A prompt version change invalidates facets rather than mixing
incompatible ones in a single space.

## Embedding

Facets are embedded through `ClusteringEmbeddingPort`, which already exists
as a port distinct from query embedding. That separation matters here: the
clustering space is independent of the retrieval space and does not need to
match the workspace's retrieval profile.

A reduced dimension is available and worth taking. The `text-embedding-3`
family accepts a requested dimension count and truncates accordingly, and 256
dimensions is ample for clustering short uniform texts. At current traffic
this buys storage and nothing else — clustering is fast either way — so treat
it as a default rather than a requirement. It becomes load-bearing only at
the volumes noted under Scale.

Store the profile identity with the vector. An embedding profile change makes
stored vectors incomparable and requires re-embedding; the facet text itself
survives, so re-embedding is cheap and needs no model call.

## Clustering

Use k-means with seeded k-means++ initialization. Skip UMAP and skip
density-based clustering.

UMAP is stochastic, and a dashboard whose topic sizes shift between identical
runs is worse than one that samples honestly. Density-based clustering is
attractive for its native noise handling, but a correct HDBSCAN is a
substantial implementation and its parameters are no easier to reason about
than `k`. Plain k-means over normalized facet vectors is what Clio uses, and
it is a few dozen lines.

**Choosing k.** Derive it from a target average cluster size rather than
picking it directly:

```
k_base = clamp(ceil(n / target_members), k_min, k_max)
```

with `target_members` around 20–50. This yields fine-grained base clusters
that track the data, then a second k-means over the base centroids
agglomerates to a top level of eight to twelve operator-visible topics. The
hierarchy is the same primitive applied twice, and it gives the drill-down
behavior for free.

**Determinism.** Seed the PRNG from a hash of the input — workspace, window
bounds, and the sorted facet identifier set — so identical input yields an
identical seed and identical output, while changed input correctly yields a
changed result. Run a fixed number of restarts and keep the lowest-inertia
solution; with a fixed seed sequence this stays deterministic.

**Scale.** Full k-means is `O(n · k · d · iterations)`. Current traffic is
order 1,000 questions per month, so a 30-day window holds a few hundred
questions and a 12-month window around 12,000. At n = 12,000, k = 240,
d = 256, and 25 iterations that is roughly 1.8 × 10¹⁰ multiply-adds — a few
seconds of background work, and this is the widest window the product would
plausibly ask for. Every analysis can therefore re-cluster its window from
scratch.

That is worth stating plainly because it removes a whole layer of design.
Mini-batch k-means, incremental assignment, and re-clustering triggers all
exist to avoid a full pass that this deployment can simply afford. The
threshold where they start to matter is roughly n above 100,000 per window,
or full-pass wall-clock exceeding the refresh timeout — an order of magnitude
away. Building them now would be paying for a scale problem in advance and
carrying the complexity in the meantime.

## Naming

One model call per cluster, given exemplar facets. Draw exemplars from two
places: the members nearest the centroid, which show what the cluster is
about, and members spread toward its edges, which show how wide it is. Six
prototypical and four peripheral is a reasonable starting split.

The existing audience pulse prompt is close to the right shape already —
narrow it from "group and name these 80 questions" to "name this group."
Removing the grouping obligation also removes the `evidenceIds` partition,
the eight-theme ceiling, and the model's ability to silently omit evidence it
could not place.

## Topic identity across analyses

This is the part that is not commodity, and it is what makes the page answer
"is this growing?"

Clusters are anonymous. To carry a topic across analyses, match the new
cluster set against the previous one and classify each relationship. Because
successive analyses over overlapping windows share questions, the strongest
signal is **membership overlap**, not centroid distance.

For a prior topic `A` and a new cluster `B`, over the questions the two
analyses have in common:

```
containment(A → B) = |A ∩ B| / |A|
containment(B → A) = |A ∩ B| / |B|
```

Classify with two thresholds, `τ_survive` (both directions, around 0.5) and
`τ_part` (one direction, around 0.3):

- **Survived** — one `B` where both containments exceed `τ_survive`. `B`
  inherits `A`'s identifier and label. No naming call.
- **Split** — several `B` each exceeding `τ_part` from `A`. Each descendant
  gets a new identifier recording `A` as parent, and each is named.
- **Merged** — one `B` exceeding `τ_part` from several prior topics. `B` gets
  a new identifier recording all parents, and is named.
- **Emerged** — a `B` matching nothing. New identifier, named.
- **Dissolved** — an `A` matching nothing. Recorded, not deleted, so a topic
  that comes back can be recognized.

Resolve ambiguity — several plausible pairings at once — as maximum-weight
bipartite matching over the containment scores, restricted to pairs above
threshold. The Hungarian algorithm is the standard solution and is small
enough to implement.

When two analyses share no questions, membership overlap is undefined; fall
back to cosine similarity between the stored centroids, with a separate
threshold. Treat this as the weaker path, because centroids drift for reasons
unrelated to topic identity.

The transition vocabulary — survived, split, merged, emerged, dissolved —
comes from the cluster-tracking literature, where it is well established.
Recording transitions rather than only the current state is what lets the
dashboard explain a topic that halved because it split, as opposed to one
that halved because interest fell.

## Deciding what is unclassified

k-means assigns every point to some cluster, so "unclassified" needs its own
rule. Two apply together.

**Distance.** Each topic derives a radius from its own members — the 90th
percentile of member-to-centroid distance, say. A member beyond its topic's
radius by some margin is reported as unclassified instead.

The per-topic learned radius is what makes this work without a hand-tuned
global threshold. A tight, well-defined topic gets a tight radius and a broad
one gets a broad radius, where a single global cosine floor would be wrong
for both and would need retuning per workspace and per language.

**Size.** A cluster below a minimum viable size is not a topic; its members
are unclassified. This is what stops eight questions from becoming eight
topics on a quiet workspace.

Unclassified is a real finding rather than a failure. Over a census, "18% of
what visitors ask fits no topic" locates the unknown demand, which is the
most actionable line the page can carry.

Incremental assignment — routing new questions into existing topics by radius
without re-clustering — is the natural extension here, and it is deliberately
absent. At the volumes under Scale, re-clustering the window is cheaper than
maintaining the incremental path, and topic stability is already handled by
identity matching rather than by avoiding recomputation.

## Cost

Per question, paid once, ever: one cheap extraction call at roughly 300 input
and 40 output tokens, and one embedding of a ~30-token facet.

At order 1,000 questions per month that is around 340,000 extraction tokens
and 30,000 embedding tokens across the whole fleet, monthly, on the cheapest
tier that produces usable facets. The backfill is a one-off of the same
magnitude. This is not a cost that needs managing at current volume, which is
worth knowing before the design is shaped around avoiding it.

Per analysis: k-means on CPU, plus naming calls only for topics that emerged,
merged, or split. A workspace whose traffic mix is stable issues zero model
calls on refresh.

Compare with today: one 8,000-token reasoning call per refresh, reading 80
questions, recomputing everything from scratch, every time. The census is
cheaper per refresh and its per-question cost amortizes to zero.

## Validating the facets

Facet quality is the load-bearing assumption in this design, and it is the
one thing that cannot be checked by unit tests. Build the evaluation before
the pipeline.

Assemble a fixture of a few hundred real visitor questions with topic labels
assigned by hand, including a deliberately multilingual subset where the same
intent appears in several languages. Run extraction and clustering over it
and score the resulting partition against the hand labels with adjusted Rand
index or normalized mutual information. Both are standard for comparing a
clustering against a reference partition, and both are deterministic, so they
belong in the existing deterministic eval harness rather than the live suite.

That fixture answers the question that decides the whole design: do facets
put the same intent in the same place across languages and phrasings? If they
do not, no amount of clustering sophistication rescues it.

## Failure modes

**Facet drift.** Changing the extraction prompt changes the space. Store the
prompt version with every facet and re-extract on change rather than mixing
generations.

**Degenerate clustering.** A workspace where every question is near-identical
produces arbitrary splits at any `k` above one. Guard with a minimum viable
cluster size and by checking that inertia actually improves with `k`; collapse
to a single topic when it does not.

**Everything unclassified.** If extraction fails broadly, questions must
still count toward the window total as unclassified. Silently narrowing the
denominator would recreate the exact defect this feature removes.

**Identity thrash.** Thresholds set too tight make every analysis look like a
mass extinction. `τ_survive`, `τ_part`, the re-cluster trigger fraction, and
the radius quantile all belong in typed configuration, tunable per
deployment, with the eval fixture measuring identity stability across
synthetic drift.

**Profile change.** An embedding profile change invalidates every stored
vector. Detect it by comparing the stored profile identity, and re-embed from
the retained facet text.

## Prior art

- **Clio** (Anthropic, arXiv 2412.13678) — the closest analogue. Verified
  against the paper: facets are attributes extracted per conversation, some
  computed and some model-extracted; embeddings are built from the *summary
  facets* rather than raw conversations ("we create embeddings from the
  summary facets"); clustering is k-means, with no UMAP or HDBSCAN stage named
  anywhere; each cluster gets a title and summary from a model reading sample
  conversations; and the hierarchy comes from "a method that combines k-means
  clustering and prompting."

  Where this design departs from Clio, and why:

  - **Choice of k.** Clio states only that k "can be quite large" and is
    "adjusted based on the size of the dataset". It publishes no formula. The
    `k = n / targetMembers` derivation here is a local engineering choice, not
    something inherited from the paper.
  - **Radius and unclassified rules.** Clio has no equivalent. Its
    minimum-size rule is a privacy threshold, not an outlier test.
  - **Cross-run topic identity.** The paper does not address whether cluster
    identity persists across separate runs. The containment matching and the
    survived/split/merged/emerged/dissolved vocabulary come from the
    cluster-tracking literature below, not from Clio.
  - **Privacy layers.** Clio runs four: summarize-without-private-info,
    minimum cluster size over both unique *accounts* and conversations,
    name-without-private-info, and a final pass where a model reads every
    cluster summary and drops any containing private information. This design
    has the first and a size threshold; it has no unique-account threshold
    (a single-workspace operator already owns all the data) and **no final
    audit pass**. That last omission is a real gap against Clio, not a
    simplification the single-tenant argument covers, because topic titles are
    generated from real visitor questions and shown to an operator.
  - **Embedding model.** Clio's cited work points at sentence-transformer
    models; this uses `text-embedding-3-small` at 256 dimensions.
- **Kura** (`github.com/jxnl/kura`) — the most readable open reproduction of
  Clio. Python; useful as a reference implementation, not a dependency.
- **OpenClio** (`github.com/R0bk/openclio`, `github.com/Phylliida/OpenClio`) —
  two further reproductions, the second oriented at local models.
- **BERTopic** — the standard embed → reduce → cluster → label pipeline, with
  model-based labeling as a first-class step. Its UMAP and HDBSCAN stages are
  the parts this design declines, for determinism and implementation cost.
- **MONIC** and the evolutionary-clustering literature — the survived, split,
  merged, emerged, dissolved vocabulary and the overlap-based tracking method.
