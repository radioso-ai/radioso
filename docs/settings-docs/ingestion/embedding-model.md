---
title: "Embedding Model"
description: "Workspace setting to choose the embedding model for creating search vectors supporting OpenAI and Google Gemini."
last_updated: 2026-05-18
---

# Embedding Model

## Summary
Choose the model used to create search vectors for this workspace.

## Details
### Overview

The embedding model turns document chunks and search queries into vectors.

Radioso uses those vectors for semantic retrieval.

Radioso supports OpenAI embedding models and Google Gemini Embedding for workspace indexing. Google embedding models require `GEMINI_API_KEY` to be configured on the backend.

Each workspace stores vectors with the dimensionality returned by its active embedding model. For example, OpenAI `text-embedding-3-large` can use its native vector size instead of being reduced to the default OpenAI small-model size.

Anthropic does not currently provide a native embedding model. Claude can still be used for chat, rewrite, and reranking flows when configured separately.

Models without configured provider credentials are shown as unavailable.

### How It Applies

This setting is workspace-specific.

It applies to:

- new document uploads
- document updates
- future reprocessing jobs
- retrieval queries for the workspace

Changing this setting asks for confirmation because existing documents must be re-indexed.

When you confirm the change, Radioso saves the new model as a pending model and queues existing documents for reprocessing. Retrieval keeps using the active model until reprocessing catches up.

If re-indexing cannot be queued, the pending model change is rolled back.

You can cancel a pending model change. If some documents were already re-indexed with the cancelled model, reprocess existing documents to restore the active model.

### Practical Implication

If you change the embedding model, let the re-indexing job finish so stored chunks and new search queries use the same vector space.

Until reprocessing finishes, semantic search stays on the active model. This avoids mixing vectors from different embedding models or vector dimensions in one search.

Existing installations label pre-upgrade chunks with the default OpenAI embedding model. This matches the default deployment path. If an installation used a different embedding model before this setting existed, re-index the workspace after upgrade.
