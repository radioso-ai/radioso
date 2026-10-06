---
title: "Rerank Top K"
description: "Retrieval setting controlling how many reranked candidates proceed to context assembly and answer composition."
last_updated: 2026-10-06
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

The system never keeps fewer than 12 candidates (the final context target), and never more than 50: a value below 12 acts as 12, and a value above 50 is capped at 50. This prevents a very low rerank value from accidentally limiting broad answers to only a few sources. Whatever this setting is set to, the answer itself still only ever uses up to 12 passages, at most 2 per document, each cut to 900 characters — `Rerank Top K` controls the shortlist reranking judges, not how much of it survives into the prompt.

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
- reranking has a wider field to re-sort before the 12-passage cutoff applies

The downside is that weaker chunks also survive into reranking, which can make the final 12 feel less focused if reranking promotes a second-tier chunk over a stronger one further down the shortlist.

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
