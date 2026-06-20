---
title: "Maximum Chunk Size"
description: "Workspace setting for limiting maximum semantic chunk size to improve retrieval precision and downstream cost."
last_updated: 2026-05-17
---

# Maximum Chunk Size

## Summary
Stop growth once a semantic chunk reaches this upper bound.

## Details
### Overview

This setting limits the maximum size of a semantic chunk. Even when a topic is cohesive, an oversized chunk can reduce retrieval precision and consume unnecessary prompt space downstream.

### Why It Matters

Very large chunks:

- reduce precision
- dominate retrieval results
- increase downstream context cost

### Tuning Guidance

Reduce this value if semantic chunks feel too broad. Increase it if related text is being split too aggressively.
