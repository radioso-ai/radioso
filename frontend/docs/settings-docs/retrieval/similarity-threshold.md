---
title: "Similarity Threshold"
description: "Retrieval setting for minimum semantic similarity score to keep candidates in the pool, balancing precision and recall."
last_updated: 2026-07-18
---

# Similarity Threshold

## Summary
Drop semantic matches that fall below this minimum similarity score.

## Details
### Overview

This sets the minimum semantic similarity score required for a candidate to remain in the retrieval pool.

It applies inside semantic vector search, before semantic and lexical results are merged. It does not filter lexical results and is not compared with the normalized fused candidate score shown in retrieval diagnostics or stored answer metadata.

### Higher Values

Higher threshold means:

- weak matches are rejected earlier
- retrieval gets cleaner
- recall may drop

This helps when your corpus has lots of vaguely related material.

### Lower Values

Lower threshold means:

- looser semantic matching
- more candidates survive
- more risk of noisy evidence

This helps when useful evidence is phrased differently from the query.

### Interaction With Top K

This setting and `Vector Top K` work together:

- high `Top K` + high threshold = wide search, hard filter
- high `Top K` + low threshold = wide search, loose filter
- low `Top K` + high threshold = narrow and strict

### Tuning Signals

- If the system finds "kind of related" chunks too often, increase it.
- If it misses passages that obviously mean the same thing in different words, decrease it.
