# Settings Docs

This directory is the source of truth for workspace control copy used by the frontend dashboard UI.

## Structure

- `ingestion/`: copy for ingestion-stage controls
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

The frontend parser in [`frontend/components/dashboard/settings/settings-docs.ts`](../../frontend/components/dashboard/settings/settings-docs.ts) reads these sections and maps them into the dashboard help UI.

## UI mapping

The Knowledge Base dashboard surface presents ingestion and retrieval controls in pipeline order:

1. Ingestion: choose chunking strategy -> tune chunk sizing -> reprocess existing documents
2. Retrieval: rewrite query -> retrieve/filter candidates -> rerank -> present grounded evidence

Assistant identity, conversation mode, custom answer instruction, proactive greeting, and suggested follow-up behavior belong to the Agent behavior surface. Retrieval controls should stay focused on evidence gathering, ranking, filters, validation outcomes, and citation presentation.

The connector-style stage separators are rendered in [`frontend/components/dashboard/settings/settings-flow.tsx`](../../frontend/components/dashboard/settings/settings-flow.tsx) and reused by the retrieval trace graph for visual consistency.

## Editing guidance

- Keep `Summary` short enough to scan beside the control.
- Put the full explainer in `Details`.
- Use actual markdown structure where it helps. Headings, bullet lists, short examples, and code spans are all appropriate.
- If a new settings field is added, create its `.md` file here and wire it into the registry in `settings-docs.ts`.
