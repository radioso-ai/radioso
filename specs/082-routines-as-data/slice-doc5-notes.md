# Slice 5 Notes: Documentation Rewrite

**Date**: 2026-06-12
**Branch**: `routine-text-composer`
**Scope**: `amendment-authoring-surface.md` §12 item 5 only.

## Delivered

- Rewrote `docs/authoring-routines.md` around the outline editor as the primary
  authoring path.
- Covered outline step cards, variables, `@` mentions, action insertion, branch
  rows, row-order precedence, default-last behavior, counter exhaustion to the
  default branch, ends, handoff, drafting assist, validation diagnostics, and the
  transitional form view.
- Added engineer-facing fixture notation to
  `docs/architecture/conversational-routines.md`.
- Left `docs-portal/content/` unchanged because no page there describes routine
  authoring or routine guard/step enum values.
- Left `readme.md` unchanged. The slice does not change Docker flow,
  authentication or token setup, common API usage, ingestion, retrieval settings,
  or operator-tuned settings. Existing README links to `docs/authoring-routines.md`
  remain sufficient.

## Accuracy Checks

Author-facing UI wording was checked against:

- `frontend/components/dashboard/settings/assistant-routines-section.tsx`
- `frontend/lib/routine-outline.ts`
- `frontend/tests/e2e/routines-settings.spec.ts`

Implementation details reflected in the docs:

- The editor has **Outline** and **Form** tabs, and Outline is the primary path.
- New-routine Outline view exposes **Draft from procedure**, **Procedure text**,
  and **Load proposal**.
- Variables expose key, type, description, and **Required**.
- Step cards expose **Step label**, **Instruction**, **Insert variable**, and
  **Insert action**.
- Branch rows expose **Condition**, **Target**, **Max N**, and **Outcome status**
  only on steps with a known action.
- Branch row inference matches `frontend/lib/routine-outline.ts`: counter limit
  -> `counter`, outcome status -> `outcome`, condition -> `llm`, otherwise
  -> `default`.
- Ends expose label, message, and **Handoff**.
- The current dashboard action catalog exposes `Contact Send`.

Enum values were checked against `backend/src/modules/routines/domain.ts`:

- step kind: `chat`, `tool`, `action`
- guard kind: `llm`, `default`, `slot_filled`, `outcome`, `counter`
- terminal kind: `complete`, `handoff`
- slot type: `text`, `number`, `boolean`, `email`, `date`

## Placement Decision

Fixture notation was added to `docs/architecture/conversational-routines.md`
instead of the authoring guide because it is explicitly not an authoring surface
(FR-020a). That architecture page already explains routine parts, guard
semantics, runtime behavior, and module boundaries, so it is the narrowest
engineer-facing home for fixture/debug notation.

The authoring guide intentionally does not document fixture sigils. It documents
only the dashboard outline and the transitional form view.

## Docs Portal Review

Command:

```bash
rg -n "routine|routines|guard|step kind|guardKind|always|fallback|fork|handoff|Draft from procedure|outline" docs-portal/content
```

Result: matches were in clarification and unrelated operational/API pages. No
docs-portal page describes routine authoring or routine guard/step enums, so no
portal content was edited and no portal lint/build was required.

## Validation Evidence

Docs-portal validation was not run because `docs-portal/content/` was untouched,
per the slice instruction.

Whitespace and diff/status checks:

```bash
git diff --check
```

Result: passed.

```bash
git diff -- docs/authoring-routines.md docs/architecture/conversational-routines.md
git status --short
```

Result: only the two docs files were modified before this notes file was added.

## Commit Status

No commit, push, or PR was created, per instruction.
