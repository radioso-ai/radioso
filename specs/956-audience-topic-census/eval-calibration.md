# Facet-quality gate: calibration against a second independent reference

Measures the practical ceiling for the facet-quality gate
(`backend/tests/unit/eval-suite/facet-quality.test.ts`) by building a second,
independent reference labelling of the same 318 real questions
(`backend/tests/fixtures/facet-quality/questions.ts`) and measuring how much
two independent, competent labellings of the same traffic agree with each
other. That agreement is the practical upper bound for any clustering: it is
the level at which two reasonable observers stop agreeing about what the
topics even are.

This does not change the test, its fixture, or its thresholds. It only
measures.

The numbers below were produced against the real question text. That text is
customer traffic and is not committed — `questions.ts` carries the labels,
`recorded.json` carries the embeddings, and the source corpus lives outside
version control (see `backend/scripts/dev/facetQualitySourceCorpus.ts`).
Reproducing the labelling passes therefore needs that corpus; reproducing the
gate itself does not.

## Method

**Reference A** (committed): `taxonomy.json` + the `topic` field in
`questions.ts`. gpt-5.2, two passes — propose 8-12 topics from the full
question set, then assign each question a topic slug or `null` in isolation.
12 topics, 294 of 318 questions labelled (24 `null`).

**Reference B** (produced for this measurement by
`backend/scripts/dev/recordFacetQualityReferenceB.ts`, output committed at
`specs/956-audience-topic-census/reference-b.json`): gpt-5.2, same two-pass
shape, built independently:

- never shown `taxonomy.json` or the `topic` field of `questions.ts`
- question order for the taxonomy-proposal pass shuffled with a fixed seed
  distinct from the taxonomy pass and from the clustering seed
- topic count left to the model's judgment in [8, 12], not steered to 12
- prompt wording written fresh, not a replay of whatever produced reference A
  (that prompt was never committed, so there was nothing to replay)

Reference B independently landed on 12 topics and left 16 of 318 `null`:

| slug | label | count |
|---|---|---|
| content_media_and_livestreams | Content discovery, videos, and livestreams | 56 |
| retreats_events_and_visits | Retreats/events info & visiting logistics | 50 |
| kriya_yoga_initiation_and_kriyaban | Kriya Yoga initiation & Kriyaban access | 40 |
| spiritual_teachings_and_practice | Spiritual teachings & practice questions | 36 |
| local_centers_and_groups | Local centers & meditation groups | 27 |
| courses_recommendations_and_pricing | Course selection, beginners, and pricing | 24 |
| teachers_lineage_and_biographies | Teachers, speakers, and lineage info | 19 |
| personal_emotional_support | Personal emotional distress & requests for human help | 19 |
| online_platform_accounts_and_purchases | Online platform, accounts, and purchases | 11 |
| products_flower_essences_and_shop | Products: sprays/flower essences & purchasing | 9 |
| seva_volunteering_and_jobs | Seva, volunteering, and work opportunities | 6 |
| organizational_controversy_and_safeguarding | Controversy, allegations, and trust/safety concerns | 5 |
| *(none)* | — | 16 |

The two taxonomies overlap substantially in shape (retreats/booking, Kriya
Yoga, teachings, locations, courses/platform, lineage, seva, products all
appear in both) but disagree at the edges: reference A puts most of the
adversarial/off-topic/distressed messages in `null`; reference B carves a
sizeable share of that same traffic into two topics of its own,
`personal_emotional_support` (19) and
`organizational_controversy_and_safeguarding` (5), that reference A has no
equivalent for. That disagreement about what counts as "a topic" versus "does
not fit" is itself evidence for why the ceiling is well under 1.0 — it is not
only label noise, it is a genuine taxonomy-design difference between two
competent passes over the same data.

Agreement and clustering scores reuse the verified metric implementations in
`backend/tests/support/partitionAgreement.ts`
(`adjustedRandIndex`, `normalizedMutualInformation`) and the same
deterministic k-means (`backend/tests/support/deterministicKmeans.ts`,
seed `facet-quality/956`, k = 12) and recorded embeddings
(`backend/tests/fixtures/facet-quality/recorded.json`) the committed test
uses, so the predicted clustering is bit-for-bit identical to what the test
scores against reference A — only the reference labels change. Recomputing
the reference-A scores this way reproduced the committed test's own numbers
exactly (facet ARI 0.2194, raw ARI 0.1808), which is the sanity check for
this whole measurement.

## Results

| measure | facets vs A (n=294) | raw vs A (n=294) | facets vs B (n=302) | raw vs B (n=302) |
|---|---|---|---|---|
| ARI | 0.2194 | 0.1808 | 0.1858 | **0.2707** |
| NMI | 0.3974 | 0.3785 | 0.3641 | **0.4276** |

**Ceiling — reference A vs reference B**, over the 287 questions both
labelled non-null:

| measure | value |
|---|---|
| ARI | 0.4923 |
| NMI | 0.6679 |

Restricting the "vs B" clustering scores to that same 287-question
intersection (so the comparison isn't affected by the ~15 items only
reference B labelled) gives ARI 0.1849 (facets) / 0.2653 (raw) and NMI 0.3649
/ 0.4204 — the same ordering, so the flip is not an artifact of reference B's
extra labelled items.

## The ordering flips

Against reference A, facets beat raw questions (ARI 0.2194 vs 0.1808, a
+0.039 margin — this is what the committed test currently checks and
passes). Against reference B, raw questions beat facets (ARI 0.2707 vs
0.1858, a −0.085 margin in the other direction, larger than the first
margin). NMI moves the same way in both cases. The "facets beat raw" result
is not robust across independent references at this sample size and this
level of overall signal; it held for the one reference the gate currently
checks against and reversed, by a wider margin, against an independently
built one.

## Ceiling versus the current floor

The current gate floor is `OVERALL_ARI_FLOOR = 0.6`
(`backend/tests/unit/eval-suite/facet-quality.test.ts:145`), calibrated on a
synthetic, cleanly-separated 8-topic fixture. The measured ceiling on this
real, overlapping, 12-topic traffic — two independent gpt-5.2 labellings of
the same 318 questions — is ARI 0.4923. A floor above the ceiling is not a
strict-but-fair bar; it is unreachable by construction, because it demands
more agreement with any one reference labelling than two competent
labellings reach with each other. 0.60 fails that test regardless of what
the clustering does.

## Recommended floor

Frame the floor as a fraction of the measured ceiling, not an absolute
number: expect an automated clustering to recover a portion of what two
independent competent labellings agree on, not to approach 1.0 on data this
overlapping.

Measured performance against the ceiling (0.4923):

| | vs A | vs B | mean |
|---|---|---|---|
| facets | 44.6% | 37.7% | 41.1% |
| raw questions | 36.7% | 55.0% | 45.9% |

Both representations land in the 37-55% range of ceiling, with substantial
spread depending on which reference is used — which is itself the point:
at this signal level, a fixed target of "beat 60% of ceiling" or similar
would be sensitive to which reference happened to be picked, not just to
clustering quality.

The four measured ARI cells range from 0.1808 (raw vs A, the lowest) to
0.2707 (raw vs B, the highest); the four NMI cells range from 0.3641 (facets
vs B) to 0.4276 (raw vs B).

**Recommended `OVERALL_ARI_FLOOR`: 0.15**, about 30% of the measured
ceiling and with margin below the lowest of the four measured cells
(0.1808). Reasoning:

- It sits below every measured cell with real margin (≥0.03), so it catches
  an actual regression — a change that meaningfully degrades either
  representation — without being tripped by the reference-dependent swing
  already observed between A and B on an otherwise-unchanged pipeline. A
  floor set right at the lowest observed cell would have near-zero margin
  against that same kind of noise.
- It stays well clear of 0 (chance), so it still requires real
  above-chance structure, not merely "reduced from a synthetic threshold to
  the point it always passes."
- It is derived from measurements on this feature's own real, overlapping,
  multi-topic data rather than carried over from a synthetic, cleanly
  separated fixture that does not represent production traffic.

**`OVERALL_NMI_FLOOR`**: the same reasoning gives roughly 0.30, about 45%
of the measured NMI ceiling (0.6679) and with margin below the lowest
measured NMI cell (0.3641).

**The unconditional "facets beat raw" assertion** is a separate question
from the ARI/NMI floor, but this measurement bears on it directly: that
assertion is currently unconditional
(`expect(facets.overall.ari).toBeGreaterThan(rawQuestions.overall.ari)`,
`facet-quality.test.ts:167`) and is checked against exactly one reference.
This measurement shows it reverses, by a larger margin than it holds by,
against an independently built second reference on the same data. Whatever
floor decision is made, that assertion should not be read as a settled
result from a single-reference test.

## Multilingual subset

Not re-measured against reference B. Reference B was not asked to reproduce
`crossLingualGroup` (the paraphrase-group labels that define the
multilingual subset in reference A), so there is no independent multilingual
partition to score against — extending that would mean re-deriving
cross-lingual groups from reference B's own labels, which is a materially
different measurement than the one requested here.
