---
title: "Minimum Chunk Size"
description: "Chunking setting that prevents semantic chunking from creating tiny unusable text segments."
last_updated: 2026-07-27
---

# Minimum Chunk Size

## Summary
Keep semantic and recursive chunking from emitting fragments too small to be useful.

## Details
Semantic and recursive text chunking split at natural boundaries, and sometimes a natural boundary lands almost immediately — a one-line heading, a short aside, a two-sentence note. On its own, such a fragment carries little for retrieval to match against. This lower bound tells the chunker to keep pulling in neighboring text until a segment reaches a usable size before it stands as its own chunk.

Raise it if you see very short, context-poor chunks surfacing in results. Lower it if genuinely distinct short passages are being glued onto unrelated neighbors. It does not affect fixed-window chunking, which sizes every chunk the same way regardless.
