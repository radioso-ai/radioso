---
title: "Rerank Top K"
description: "Retrieval setting controlling how many reranked candidates proceed to context assembly and answer composition."
last_updated: 2026-04-02
---

# Rerank Top K

## Summary
Choose how many retrieved candidates are sent through reranking.

## Details
### Overview

This setting determines the size of the shortlist that reranking evaluates.

### Pipeline Role

1. Search returns a candidate pool.
2. `Rerank Top K` chooses a shortlist from that pool.
3. Reranking sorts that shortlist from strongest to weakest.
4. Final context assembly then applies its own separate context count and token budget.

So this setting does not directly set the number of citations in the final answer. It controls how much retrieved evidence reranking gets to judge before the final prompt is assembled.

In practice, the system will keep enough rerank candidates to fill the final context target when that many candidates are available. This prevents a very low rerank value from accidentally limiting broad answers to only a few sources.

### Lower Values

Lower values mean:

- tighter focus
- fewer chunks considered by reranking
- less noise in the answer prompt

This is useful when you want very direct answers and the best evidence is usually concentrated in just a few chunks.

The downside is that you can cut away useful supporting context too early, especially for multi-part or broad questions.

### Higher Values

Higher values mean:

- more evidence reaches reranking
- recall is preserved better
- the answer generator has more context to work with

The downside is that weaker chunks also survive, which can make answers feel less focused or cause the prompt budget to be spent on second-tier evidence.

### Example

Imagine retrieval returns 20 candidates and reranking sorts them well.

- `Top K = 3`: reranking uses the minimum shortlist needed for final context assembly
- `Top K = 10`: reranking evaluates a wider shortlist

If the best answer depends on one main passage plus two supporting passages, `3` may be enough.

If the question asks for comparisons, exceptions, or multiple policies, `3` may be too aggressive.

### Tuning Guidance

- If answers feel **too narrow**, raise this.
- If answers feel **crowded or noisy**, lower this.
- Tune it together with `Vector Top K` and `Reranking`, because those settings define the size and quality of the pool that reaches this cutoff.
