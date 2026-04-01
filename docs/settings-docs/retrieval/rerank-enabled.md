# Reranking

## Summary
Use the reranker to reorder retrieved candidates before context selection.

## Details
### Overview

Reranking is the stage that reorders retrieved candidates with a stricter relevance judgment after the initial candidate pool has been assembled.

### What Changes

- The system runs retrieval first.
- It receives a candidate pool from semantic and lexical search.
- Then the reranker looks at those candidates with the question in mind and reorders them.
- Later stages, like context assembly and answer generation, mostly see the reranked order rather than the raw search order.

So this setting does **not** widen search. It improves the quality of the ranking *after* search has already happened.

### Why It Helps

Initial retrieval is optimized for recall and speed.

That means it often returns:

- chunks that are related to the topic
- chunks that mention the same terms
- chunks that are "close enough"

But "close enough" is not always the same as "best support for the answer."

Reranking helps when several chunks are all plausible matches and the system needs help deciding which ones are truly most useful.

### Expected Behavior

If your retrieval pool is small and already very clean, reranking may not visibly change much.

If your retrieval pool is broad, messy, or full of near-matches, reranking can make a major difference:

- better supporting passages rise to the top
- weakly related chunks fall lower
- final answers tend to feel more grounded and less distracted

### Tradeoffs

- **Quality:** usually better
- **Latency:** usually a bit slower
- **Recall:** unchanged directly, but better ranking can make the final selected context more useful

### Usage Guidance

Turn it on when:

- answers feel noisy
- the system grabs related chunks but not the most convincing ones
- your corpus has many documents on similar topics

Leave it off when:

- raw retrieval is already clean enough
- you care more about speed than answer polish
- your candidate pool is tiny and obvious
