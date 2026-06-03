# @radioso/docs-importer

Imports the documentation portal into a Radioso workspace so an agent can answer
questions about Radioso itself. Reads the repo's own sources — no deployed docs
site required — and upserts them through the public REST API.

## Sources

- **Narrative docs** — `docs-portal/content/**/*.mdx`. Parsed via the remark/mdx
  AST and flattened to plain markdown; Nextra components (`<Callout>`, `<Cards>`,
  `<Steps>`) are flattened so their prose survives, and root-relative links are
  rewritten to absolute docs URLs. One document per page.
- **API reference** — `backend/openapi.json`. The portal renders this with a
  client-side Stoplight widget, so it is not MDX; this package renders it to
  markdown, one document per OpenAPI tag (method, path, params, request/response
  schemas with local `$ref`s dereferenced).

## Sync semantics

Each document is uploaded as a `website`-sourced document with a stable
`externalDocumentId`. The backend short-circuits unchanged pages by content hash,
so re-running is idempotent. `--prune` removes previously imported documents that
are no longer present, scoped strictly to documents carrying our
`metadata.section` (`mdx-docs` / `api-reference`) — it never touches other docs.

## Usage

```bash
# Preview the documents without uploading (no network):
pnpm --filter @radioso/docs-importer run import -- --dry-run

# Upload to a target workspace:
RADIOSO_BASE_URL=https://platform.radioso.dev \
RADIOSO_API_TOKEN=<workspace-token> \
CITATION_BASE_URL=https://docs.radioso.dev \
pnpm --filter @radioso/docs-importer run import -- --prune
```

### Flags

- `--dry-run` — build and list documents, upload nothing (no API token needed).
- `--prune` — delete owned documents no longer present in the sources.
- `--no-mdx` / `--no-api` — import only one of the two source sets.

### Environment

- `RADIOSO_BASE_URL` — target instance (e.g. `https://platform.radioso.dev`).
- `RADIOSO_API_TOKEN` — workspace token for the destination workspace.
- `CITATION_BASE_URL` — public docs base for `source`/citation URLs
  (default `https://docs.radioso.dev`).

## Tests

```bash
pnpm --filter @radioso/docs-importer test
```
