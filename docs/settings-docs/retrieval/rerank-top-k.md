# Rerank Top K

## Summary
Keep this many candidates after reranking.

## Details
### Overview

This setting determines how many candidates survive after reranking.

### Pipeline Role

1. Search returns a candidate pool.
2. Reranking sorts that pool from strongest to weakest.
3. `Rerank Top K` decides how many of the top results continue into downstream context assembly.

So this setting does not control whether reranking happens. It controls how strict reranking becomes.

### Lower Values

Lower values mean:

- tighter focus
- fewer chunks in the final context pool
- less noise in the answer prompt

This is useful when you want very direct answers and the best evidence is usually concentrated in just a few chunks.

The downside is that you can cut away useful supporting context too early, especially for multi-part or broad questions.

### Higher Values

Higher values mean:

- more evidence survives
- recall is preserved better
- the answer generator has more context to work with

The downside is that weaker chunks also survive, which can make answers feel less focused or cause the prompt budget to be spent on second-tier evidence.

### Example

Imagine retrieval returns 20 candidates and reranking sorts them well.

- `Top K = 3`: only the top 3 move on
- `Top K = 10`: the top 10 move on

If the best answer depends on one main passage plus two supporting passages, `3` may be enough.

If the question asks for comparisons, exceptions, or multiple policies, `3` may be too aggressive.

### Tuning Guidance

- If answers feel **too narrow**, raise this.
- If answers feel **crowded or noisy**, lower this.
- Tune it together with `Vector Top K` and `Reranking`, because those settings define the size and quality of the pool that reaches this cutoff.
