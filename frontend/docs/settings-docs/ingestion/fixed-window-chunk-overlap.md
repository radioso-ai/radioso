---
title: "Chunk Overlap"
description: "Chunking setting to reuse parts of previous chunks across boundaries for context preservation and retrieval continuity."
last_updated: 2026-04-02
---

# Chunk Overlap

## Summary
Reuse part of the previous chunk so adjacent chunks share context.

## Details
### Overview

Overlap means each chunk repeats a portion of the previous chunk. The purpose is to preserve continuity across artificial chunk boundaries.

### Why It Matters

Ideas do not naturally stop at fixed boundaries.

If the chunker cuts right through a sentence, paragraph, or explanation, retrieval may grab half the thought and miss the rest.

Overlap reduces that problem by letting neighboring chunks share some context.

### Effects Of Higher Overlap

- boundary cuts hurt less
- adjacent chunks read more naturally
- retrieval has a better chance of catching the full thought

### Costs Of Excessive Overlap

- creates many near-duplicate chunks
- increases redundancy in retrieval results
- wastes index space
- can make search results look repetitive

### Tuning Signals

- If context keeps getting cut off at boundaries, increase overlap.
- If retrieval returns multiple chunks that feel almost identical, decrease overlap.
