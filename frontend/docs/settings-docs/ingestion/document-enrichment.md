---
title: "Metadata Extraction"
description: "How metadata extraction understands documents and extracts structured tags like event dates after a document becomes searchable."
last_updated: 2026-07-08
---

# Metadata Extraction

## Summary
Understand each document's type and extract structured tags — like event dates — after the document is indexed, without delaying when it becomes searchable.

## Details
### Overview

Metadata extraction is disabled by default. When enabled, Radioso makes one model call for each processed document. The call does two things: it understands what kind of document this is (an event announcement, an article, a profile, a reference page, or something generic), and it extracts structured tags the document supports.

The call reads a bounded portion of the document (up to roughly the first 48,000 characters), so very large files add a predictable, capped model cost. The call is metered like any other model usage in the workspace.

### When It Runs

Extraction runs asynchronously, after the document is already searchable. A document first goes through indexing — chunking and embedding — and becomes queryable as soon as that finishes. Extraction is then scheduled as a separate, lower-priority job that fills in the structured tags in place.

In practice this means a document does not wait for the model call to become usable. During a large import or site crawl, every document is indexed first, and extraction drains afterward at lower priority. The extracted date tags reach retrieval when the extraction job completes; no re-indexing is needed.

In the document editor, the Extracted metadata panel shows no extracted tags until the extraction job finishes; once it completes, `Status` shows `applied` (or the failure reason if the model call could not produce valid tags).

### What It Adds

For event content, extraction writes the overall event span (`dateFrom` and `dateTo`) into the document's metadata — where you can see and edit it like any other tag — and attaches precise date tags to the parts of the document that describe each dated event, even when the date appears in a different paragraph than the event itself. For articles, it writes the publication date into document metadata the same way.

Extracted tags are refreshed on each extraction run, so manual edits to `dateFrom`/`dateTo` persist until the next run that has extraction enabled. To manage dates fully by hand, turn extraction off for the document or source and edit the metadata directly — manually set date tags flow into retrieval exactly like extracted ones after a reprocess.

Profiles, reference pages, and generic documents are still classified, but Radioso does not invent dates when the document does not support them.

### Control Levels

The workspace setting is the default for new processing jobs. A document source can follow the workspace setting, force extraction on, or force it off. A reprocess request can also force extraction on or off for that run only, and the same one-run choice is available when adding a document or importing a file. Manually added documents otherwise follow the workspace setting.

### Operational Behavior

Extraction adds model cost, so enable it where dated event retrieval is useful. Because it runs after indexing, it does not add latency to when a document becomes searchable. If extraction fails, the document stays searchable without extracted tags and records safe provenance for operators — a failed extraction never takes a document out of service.
