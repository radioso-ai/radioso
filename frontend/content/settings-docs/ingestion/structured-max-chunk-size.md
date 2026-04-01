# Maximum Chunk Size

## Summary
Stop growth once a structure-aware chunk reaches this upper bound.

## Details
### Overview

This setting limits the maximum size of a structure-aware chunk. Even when a section is logically cohesive, an oversized chunk can reduce retrieval precision and consume unnecessary prompt space downstream.

### Why It Matters

Very large chunks:

- reduce precision
- dominate retrieval results
- increase downstream context cost

### Tuning Guidance

Reduce this value if structured chunks feel too broad. Increase it if semantically related sections are being split too aggressively.
