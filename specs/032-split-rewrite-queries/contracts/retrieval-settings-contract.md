# Contract Notes: Split Rewrite Retrieval Settings

## Purpose

Document the approved additive contract changes for retrieval settings and the related retrieval-information surface before implementation.

## Retrieval Settings API

- The authenticated retrieval settings endpoints remain:
  - `GET /api/v1/settings/retrieval`
  - `PUT /api/v1/settings/retrieval`
- The settings payload remains backward-compatible and additive.
- New retrieval settings fields:
  - `semanticRewriteInstructions`
  - `lexicalRewriteInstructions`
- Existing fields remain unchanged, including:
  - `queryRewriteEnabled`
  - `rerankEnabled`
  - `vectorTopK`
  - `similarityThreshold`
  - `rerankTopK`
  - `warmthLevel`
  - `citationDisplayEnabled`
  - `metadataRules`
  - `customInstruction`

## Behavioral Contract Notes

- Older clients that omit the new instruction fields during save must not silently erase existing stored values without an explicit reset path.
- Existing workspaces that have never stored the new instruction fields must still receive usable defaults on read.
- The code-first source of truth for these schema changes is `backend/src/app/http/openapi/document.ts`.
- `backend/openapi.yaml` and `backend/openapi.json` are generated artifacts that must be regenerated after implementation; they are not planning sources of truth.

## Retrieval Information / Trace Notes

- The retrieval information surface should continue to expose `semanticQuery` and `lexicalQuery`.
- The trace summary should clearly distinguish:
  - original user query
  - active semantic query
  - active lexical query
  - rewrite status
  - fallback or rejection reason when present
- These changes are additive to existing retrieval diagnostics rather than a new endpoint contract.
