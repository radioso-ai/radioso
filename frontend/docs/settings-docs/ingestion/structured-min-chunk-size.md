---
title: "Minimum Chunk Size"
description: "Chunking setting that prevents semantic chunking from creating tiny unusable text segments."
last_updated: 2026-05-17
---

# Minimum Chunk Size

## Summary
Avoid tiny semantic text segments during chunking.

## Details
### Overview

This setting gives semantic and recursive text chunking a lower bound for very small text segments.

### Typical Small Segments

- a short sentence
- a small note
- a brief paragraph

The chunker keeps nearby text together until the segment is large enough to be useful for retrieval.
