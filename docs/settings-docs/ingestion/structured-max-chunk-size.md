---
title: "Maximum Chunk Size"
description: "Workspace setting for limiting maximum semantic chunk size to improve retrieval precision and downstream cost."
last_updated: 2026-07-27
---

# Maximum Chunk Size

## Summary
Cap how large a semantic chunk can grow, even when the topic keeps going.

## Details
Semantic chunking grows a chunk while the text stays on one topic. Left unbounded, a long cohesive passage can become a single oversized chunk that dominates every result it appears in and eats prompt space other evidence needed. This ceiling stops that growth: once a chunk reaches the limit it is closed, and the next passage starts a fresh one.

Lower it when semantic chunks feel too broad — when a returned chunk is on-topic but far larger than the sentence that actually answered the question. Raise it when clearly related text is being split more aggressively than you would like. It bounds semantic chunking; fixed-window chunk size is set separately.
