---
title: "AI Document Enrichment"
description: "How AI document enrichment classifies documents and extracts temporal facts during ingestion."
last_updated: 2026-07-02
---

# AI Document Enrichment

## Summary
Classify document shape and extract supported temporal facts during document processing.

## Details
### Overview

AI document enrichment is disabled by default. When enabled, Radioso makes one model call for each processed document to classify its shape and extract supported temporal facts.

### What It Adds

For event-shaped content, enrichment can attach `dateFrom` and `dateTo` metadata to the chunks that describe the dated event. For article-shaped content, it can add a publication date at document level.

Profiles, reference pages, and generic documents are still classified, but Radioso does not invent dates when the document does not support them.

### Control Levels

The workspace setting is the default for new processing jobs. A document source can inherit the workspace default, force enrichment on, or force it off. A reprocess request can also force enrichment on or off for that run only.

### Operational Behavior

Enrichment adds model cost and latency to processing, so enable it where dated event retrieval is useful. If enrichment fails, the document still finishes processing without enriched metadata and records safe provenance for operators.
