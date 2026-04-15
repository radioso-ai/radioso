# Settings Docs

This directory is the source of truth for workspace settings copy used by the frontend settings UI.

## Structure

- `ingestion/`: copy for ingestion-stage controls
- `general/`: copy for workspace identity and startup behavior controls
- `retrieval/`: copy for retrieval-stage and answer-stage controls
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

The frontend parser in [`frontend/components/dashboard/settings/settings-docs.ts`](../../frontend/components/dashboard/settings/settings-docs.ts) reads these sections and maps them into the settings UI.

## UI mapping

The dashboard presents settings in product order:

1. General: workspace identity, public access, website embed, and new-chat bootstrap behavior
2. Ingestion: choose chunking strategy -> tune chunk sizing -> reprocess existing documents
3. Retrieval: rewrite query -> retrieve/filter candidates -> rerank -> shape the final answer

The connector-style stage separators are rendered in [`frontend/components/dashboard/settings/settings-flow.tsx`](../../frontend/components/dashboard/settings/settings-flow.tsx) and reused by the retrieval trace graph for visual consistency.

## Editing guidance

- Keep `Summary` short enough to scan beside the control.
- Put the full explainer in `Details`.
- Use actual markdown structure where it helps. Headings, bullet lists, short examples, and code spans are all appropriate.
- If a new settings field is added, create its `.md` file here and wire it into the registry in `settings-docs.ts`.
