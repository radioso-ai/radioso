---
title: "Chunk Overlap"
description: "Chunking setting to reuse parts of previous chunks across boundaries for context preservation and retrieval continuity."
last_updated: 2026-07-27
---

# Chunk Overlap

## Summary
Repeat a slice of the previous chunk in the next one so a thought split across a boundary is not lost.

## Details
Fixed-window boundaries fall at a set length, not at the end of an idea, so a sentence or explanation can be cut in half between two chunks. Overlap softens that by having each chunk begin with the tail of the one before it, so the full thought survives in at least one chunk even when the cut lands mid-sentence.

More overlap means boundary cuts hurt less and neighboring chunks read more naturally, so retrieval is likelier to catch a complete thought. Too much, though, fills the index with near-duplicate chunks: results start to look repetitive and prompt space is spent re-reading the same lines. Increase it when context keeps getting cut off at boundaries; decrease it when retrieval returns several chunks that are almost the same text. It applies to fixed-window chunking only.
