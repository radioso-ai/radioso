---
title: "Chunk Overlap"
description: "Chunking setting to reuse parts of previous chunks across boundaries for context preservation and retrieval continuity."
last_updated: 2026-11-17
---

# Chunk Overlap

## Summary
Repeat a slice of the previous chunk in the next one so a thought split across a boundary is not lost.

## Details
A fixed-window chunk ends at a sentence end where it can, but an explanation still runs across two chunks, and a sentence longer than half a chunk is cut between two words. Overlap has each chunk begin with up to this many characters from the end of the one before it, so the thought that crosses the boundary reads whole in at least one chunk. The repeated stretch starts at the beginning of a sentence when one falls inside it, otherwise at the start of a word, and it is never more than half of the chunk it repeats.

More overlap means boundary cuts hurt less and neighboring chunks read more naturally, so retrieval is likelier to catch a complete thought. Too much, though, fills the index with near-duplicate chunks: results start to look repetitive and prompt space is spent re-reading the same lines. Increase it when context keeps getting cut off at boundaries; decrease it when retrieval returns several chunks that are almost the same text. It applies to fixed-window chunking only.
