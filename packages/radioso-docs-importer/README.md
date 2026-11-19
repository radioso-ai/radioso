# @radioso/docs-importer

Imports the documentation portal into a Radioso workspace, so an agent working on
Radioso has the product's own documentation as grounding. Reads the repo's own
sources — no deployed docs site required — and upserts them through the public
REST API.

## Sources

- **Narrative docs** — `docs-portal/content/**/*.mdx`. Parsed via the remark/mdx
  AST and flattened to plain markdown; Nextra components (`<Callout>`, `<Cards>`,
  `<Steps>`) are flattened so their prose survives, and root-relative links are
  rewritten to absolute docs URLs. One document per page.
- **API reference** — `backend/openapi.json`. The portal renders this with a
  client-side Stoplight widget, so it is not MDX; this package renders it to
  markdown, one document per OpenAPI tag (method, path, params, request/response
  schemas with local `$ref`s dereferenced).
- **Repo READMEs** — every `README.md` / `readme.md` under the repository, excluding
  generated and dependency directories. These are imported as raw markdown with one
  document per README.

- **Website pages** (opt in) — `--website-page <markdownUrl>=<citationUrl>`, repeatable.
  Fetches a public markdown page (for example `https://radioso.ai/pricing.md`) and
  imports it as one document: title from the first `# ` heading, source the page's
  origin, `metadata.url` the citation URL, `externalDocumentId`
  `radioso-website:<citation path>`. A fetch failure, non-2xx, or empty page fails
  the run, so the page is never silently dropped and then pruned.

## Sync semantics

Every document is uploaded under one common `website` source URL, derived from
`CITATION_BASE_URL`. Each item's deep link is stored in `metadata.url`, which is
the field Radioso citations resolve from. The backend short-circuits unchanged
pages by content hash, so re-running is idempotent.

`--prune` removes previously imported documents that are no longer present, scoped
strictly to documents carrying our `metadata.section` (`mdx-docs` /
`api-reference` / `repo-readme`, plus `radioso-website` when `--website-page` is used) — it never touches other docs. Prune is also
source-aware: it deletes obsolete importer-owned documents that still live under
the old per-page sources, then removes those empty legacy sources.

With `--prune` and `--website-page`, a hand-uploaded copy of the page is also deleted
once the new document is upserted: any document whose `metadata.url` equals the
citation URL exactly and whose `externalDocumentId` is not the importer's. Each
deletion is logged (id, title, externalDocumentId, sourceId). Its source is left in
place. If the document list returns no metadata at all, the importer logs a warning
and deletes nothing.

## Usage

```bash
# Preview the documents without uploading (no network):
pnpm --filter @radioso/docs-importer run import -- --dry-run

# Upload to a target workspace:
RADIOSO_BASE_URL=https://app.radioso.ai \
RADIOSO_API_TOKEN=<personal-or-service-account-token> \
CITATION_BASE_URL=https://docs.radioso.ai \
REPO_SOURCE_BASE_URL=https://github.com/radioso-ai/radioso/blob/main \
pnpm --filter @radioso/docs-importer run import -- --prune
```

### Flags

- `--dry-run` — build and list documents, upload nothing (no API token needed).
- `--prune` — delete owned documents no longer present in the sources.
- `--no-mdx` / `--no-api` / `--no-readme` — skip one source set.
- `--website-page <markdownUrl>=<citationUrl>` — also import a public markdown page (repeatable).

### Environment

- `RADIOSO_BASE_URL` — target instance (e.g. `https://app.radioso.ai`).
- `RADIOSO_API_TOKEN` — a personal token or service-account credential for the destination workspace.
- `CITATION_BASE_URL` — public docs base for the common website source and docs
  citation URLs (default `https://docs.radioso.ai`).
- `REPO_SOURCE_BASE_URL` — GitHub blob base for README citation URLs (default
  `https://github.com/radioso-ai/radioso/blob/main`).

## Tests

```bash
pnpm --filter @radioso/docs-importer test
```
