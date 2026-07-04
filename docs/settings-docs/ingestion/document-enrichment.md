---
title: "Metadata Extraction"
description: "How metadata extraction understands documents and extracts structured tags like event dates during ingestion."
last_updated: 2026-07-03
---

# Metadata Extraction

## Summary
Understand each document's type and extract structured tags — like event dates — during document processing.

## Details
### Overview

Metadata extraction is disabled by default. When enabled, Radioso makes one model call for each processed document. The call does two things: it understands what kind of document this is (an event announcement, an article, a profile, a reference page, or something generic), and it extracts structured tags the document supports.

The call reads a bounded portion of the document (up to roughly the first 48,000 characters), so very large files add a predictable, capped model cost. The call is metered like any other model usage in the workspace.

### What It Adds

For event content, extraction attaches `dateFrom` and `dateTo` tags to the parts of the document that describe the dated event — even when the date appears in a different paragraph than the event itself. For articles, it can add a publication date at document level.

Profiles, reference pages, and generic documents are still classified, but Radioso does not invent dates when the document does not support them.

### Control Levels

The workspace setting is the default for new processing jobs. A document source can follow the workspace setting, force extraction on, or force it off. A reprocess request can also force extraction on or off for that run only, and the same one-run choice is available when adding a document or importing a file. Manually added documents otherwise follow the workspace setting.

### Operational Behavior

Extraction adds model cost and latency to processing, so enable it where dated event retrieval is useful. If extraction fails, the document still finishes processing without extracted tags and records safe provenance for operators.
