---
title: "Vector Top K"
description: "Retrieval setting controlling the number of semantic candidates retained from vector search before reranking."
last_updated: 2026-04-02
---

# Vector Top K

## Summary
Set how many semantic candidates to pull from vector search.

## Details
### Overview

`Vector Top K` controls how many semantic candidates are retained after vector search.

### Higher Values

A bigger number means:

- wider recall
- more chances to include a relevant chunk
- more noise entering later stages

This is useful when the best evidence is not always ranked near the top.

### Lower Values

A smaller number means:

- tighter pool
- faster downstream work
- less noise
- more risk of missing good evidence

### Role In The Pipeline

This stage decides what later stages are allowed to see. Ranking quality is reranking's job; `Vector Top K` governs whether the good material is in the pool for reranking to find in the first place.

### Tuning Signals

- If obvious evidence is missing, raise it.
- If the system keeps dragging in weakly related chunks, lower it.
