# Quickstart: Settings UI Refresh

Verify that the redesigned settings UI improves navigation and section hierarchy without changing the underlying settings behavior.

## Prerequisites

- Local app running through the standard Radioso development flow
- Authenticated user with access to the dashboard settings area

## Validation Steps

1. Open the dashboard and navigate to `Settings`.
   - Confirm the page shows the existing tabs and a clearer tab-specific overview.

2. Test section navigation in `General`.
   - Use the local settings section index to jump to workspace/access, assistant, anonymous chat, and website embed.
   - Confirm the page scrolls to the selected section and the route anchor stays aligned.

3. Test section navigation in `Ingestion`.
   - Confirm the page groups strategy choice, active strategy tuning, and existing document reprocessing into separate sections.
   - Scroll the page and confirm save controls remain accessible.

4. Test section navigation in `Retrieval`.
   - Confirm the page groups query rewriting, search tuning, metadata rules, and answer behavior into separate sections.
   - Add or edit a metadata rule, scroll the page, and confirm save controls remain accessible.

5. Test mobile responsiveness.
   - Repeat the settings navigation flow on a narrow viewport and confirm the section index remains usable without overlapping content.

6. Regression check existing actions.
   - Rename a workspace.
   - Reveal and hide the workspace API token.
   - Toggle anonymous chat.
   - Save ingestion settings.
   - Save retrieval settings.

## Targeted Commands

```bash
cd frontend
npm test -- settings-tab-metadata.test.ts
```

If broader UI verification is needed, run the existing frontend test suite:

```bash
cd frontend
npm test
```
