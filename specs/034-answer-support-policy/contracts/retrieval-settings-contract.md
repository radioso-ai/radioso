# Contract Notes: Retrieval Settings Answer Support Policy

## Purpose

Document the approved additive contract changes for retrieval settings and the related chat debug surface before implementation.

## Retrieval Settings API

- The authenticated retrieval settings endpoints remain:
  - `GET /api/v1/settings/retrieval`
  - `PUT /api/v1/settings/retrieval`
- The settings payload remains backward-compatible and additive.
- New retrieval settings field:
  - `answerPolicy`
- Supported values:
  - `strict`
  - `warn`
  - `off`
- Existing fields remain unchanged, including:
  - `queryRewriteEnabled`
  - `semanticRewriteInstructions`
  - `lexicalRewriteInstructions`
  - `rerankEnabled`
  - `vectorTopK`
  - `similarityThreshold`
  - `rerankTopK`
  - `warmthLevel`
  - `citationDisplayEnabled`
  - `metadataRules`
  - `customInstruction`

## Behavioral Contract Notes

- Existing workspaces that have never stored `answerPolicy` must receive `strict` on read.
- Older clients that omit the field during save must not break retrieval settings reads.
- The code-first source of truth for these schema changes is `backend/src/app/http/openapi/document.ts`.
- `backend/openapi.yaml` and `backend/openapi.json` are generated artifacts that must be regenerated after implementation; they are not planning sources of truth.

## Chat Diagnostics / History Notes

- Stored assistant-turn validation metadata should include the active `answerPolicy`.
- Existing debug/history payloads should continue to expose whether validation ran and whether the answer was modified.
- These additions are additive to existing chat history/debug contracts rather than a new endpoint family.
