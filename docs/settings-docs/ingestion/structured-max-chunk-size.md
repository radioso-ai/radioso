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
