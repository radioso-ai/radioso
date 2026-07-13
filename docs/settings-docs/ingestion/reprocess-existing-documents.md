---
title: "Reprocess Existing Documents"
description: "How to requeue documents to apply updated ingestion and metadata extraction settings to already-indexed content."
last_updated: 2026-07-02
---

# Reprocess Existing Documents

## Summary
Queue current documents again so they pick up the latest ingestion and metadata extraction configuration.

## Details
### Overview

Saving ingestion settings affects future ingestion. Reprocessing applies those settings to documents that have already been indexed.

Reprocessing can also apply metadata extraction changes. A reprocess request may force extraction on or off for that run. That request-level choice applies only to the jobs it creates.

### Operational Behavior

Until reprocessing runs, previously indexed documents continue using their existing chunk layout, embeddings, and extracted metadata.

If metadata extraction is disabled for a reprocess run, Radioso rebuilds the document without keeping stale extracted dates on the new chunks.

### When To Use It

Use reprocessing after meaningful ingestion changes, especially after changing chunking strategy, chunk size, overlap, semantic chunk limits, or metadata extraction policy.
