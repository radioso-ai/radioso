# Answer-First Clarification Plan

## Slice 1 — confidence weighting

Retrieval-sense confidence now combines the existing structural confidence with a
relative query-fit score:

```text
structuralConfidence = (share + min(1, separation)) / 2
relevanceConfidence = averageSimilarity / bestAverageSimilarityInCandidateSet
confidence = (structuralConfidence + relevanceConfidence) / 2
```

The relevance term is normalized against the best average similarity among the
structurally qualified, separated groups in the same candidate set. That keeps
confidence ordinal within the set, avoids cross-turn calibration, and prevents a
small absolute similarity spread between genuinely comparable groups from becoming
decisive. Equal structure plus a decisive query-fit winner, such as the issue-686
Refund Policy versus Shipping FAQ repro, clears the existing `0.15` retrieval-sense
margin and therefore uses the existing `clear_margin` auto-pick path without policy
or engine changes.

This slice does not change the clarification contract, conversation engine,
retrieval-sense policy thresholds, prompts, pending state, or answer composition.
Structural gating remains owned by `minGroupShare` and `separationThreshold`; query
relevance only ranks the candidate confidence after those gates pass.
