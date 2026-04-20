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

1. General: Workspace and access -> Assistant Identity -> Anonymous Chat Access -> Website Embed -> Danger Zone
2. Ingestion: Choose a chunking strategy -> Tune active chunking -> Apply changes to existing documents
3. Retrieval: Rewrite the incoming question -> Tune search and reranking -> Prioritize by metadata -> Shape the final answer
4. Chat connectors: connector list and configuration, without a per-page side menu

The settings navigation shell and per-tab section metadata now live in [`frontend/components/dashboard/settings/settings-tab-shell.tsx`](../../frontend/components/dashboard/settings/settings-tab-shell.tsx) and [`frontend/components/dashboard/settings/settings-tab-metadata.ts`](../../frontend/components/dashboard/settings/settings-tab-metadata.ts).

## Editing guidance

- Keep `Summary` short enough to scan beside the control.
- Put the full explainer in `Details`.
- Use actual markdown structure where it helps. Headings, bullet lists, short examples, and code spans are all appropriate.
- If a new settings field is added, create its `.md` file here and wire it into the registry in `settings-docs.ts`.
