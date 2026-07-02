---
title: "Reprocess Existing Documents"
description: "How to requeue documents to apply updated ingestion and enrichment settings to already-indexed content."
last_updated: 2026-07-02
---

# Reprocess Existing Documents

## Summary
Queue current documents again so they pick up the latest ingestion and enrichment configuration.

## Details
### Overview

Saving ingestion settings affects future ingestion. Reprocessing applies those settings to documents that have already been indexed.

Reprocessing can also apply AI document enrichment changes. A reprocess request may force enrichment on or off for that run. That request-level choice applies only to the jobs it creates.

### Operational Behavior

Until reprocessing runs, previously indexed documents continue using their existing chunk layout, embeddings, and enrichment metadata.

If enrichment is disabled for a reprocess run, Radioso rebuilds the document without keeping stale temporal enrichment on the new chunks.

### When To Use It

Use reprocessing after meaningful ingestion changes, especially after changing chunking strategy, chunk size, overlap, semantic chunk limits, or document enrichment policy.
