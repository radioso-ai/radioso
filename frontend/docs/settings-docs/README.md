---
title: "Settings Docs"
description: "Index and structure for the workspace control copy files that power the frontend dashboard ingestion and retrieval settings UI."
last_updated: 2026-07-27
---

# Settings Docs

Workspace settings copy for the frontend settings UI. The repo holds two identical copies — the source at `docs/settings-docs/` and the dashboard import at `frontend/docs/settings-docs/` — edit both so they stay in sync.

## Structure

- `ingestion/`: copy for ingestion-stage controls
- `general/`: source copy for assistant identity and startup behavior fields; the settings registry does not import these files
- `retrieval/`: copy for retrieval-stage and retrieval-owned answer evidence controls
- one setting per file

## File format

Each setting document uses the same structure:

```md
# <Label>

## Summary
Short inline copy shown next to the setting control.

## Details
Long-form explanation shown in the right-side help panel.
```

The frontend parser in `frontend/components/dashboard/settings/settings-docs.ts` reads these sections and maps them into the settings UI. Its registry imports the `ingestion/` and `retrieval/` files.

## UI mapping

The dashboard presents settings in product order:

1. Workspace, Assistant, and Channels: workspace access, assistant behavior, anonymous chat, and danger zone
2. Ingestion: Choose chunking settings -> Tune active chunking -> Apply changes to existing documents
3. Retrieval: Rewrite the incoming question -> Tune search and reranking -> Prioritize by metadata -> Present grounded evidence
4. Connectors: connector list and configuration, without a per-page side menu

Embedding model selection belongs on the Settings -> Providers surface because it is a provider-backed model choice. It still uses ingestion settings behind the scenes because changing the embedding model affects existing chunks and may trigger re-indexing.

Assistant behavior fields such as custom answer instruction, suggested follow-ups, identity, and first greeting belong to the assistant settings surface. Retrieval settings should stay focused on rewrite, ranking, metadata filters, and citation presentation.

The settings navigation shell and per-tab section metadata live in `frontend/components/dashboard/settings/settings-tab-shell.tsx` and `frontend/components/dashboard/settings/settings-tab-metadata.ts`.

## Editing guidance

- Keep `Summary` short enough to scan beside the control.
- Put the full explainer in `Details`.
- Use actual markdown structure where it helps. Headings, bullet lists, short examples, and code spans are all appropriate.
- If a new settings field is added, create its `.md` file here and wire it into the registry in `settings-docs.ts`.
