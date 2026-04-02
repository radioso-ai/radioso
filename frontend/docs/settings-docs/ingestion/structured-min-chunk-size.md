# Minimum Chunk Size

## Summary
Merge tiny structural fragments until they reach this minimum size.

## Details
### Overview

This setting prevents structure-aware chunking from emitting fragments that are too small to be useful on their own.

### Typical Small Fragments

- a short heading
- a one-line list item
- a small note

The chunker merges these fragments with nearby content until they are large enough to be useful for retrieval.
