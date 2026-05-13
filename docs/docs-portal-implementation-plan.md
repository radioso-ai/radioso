# Docs Portal Implementation Plan

## Goal

Stand up a public-facing developer surface for Radioso that lives in this repo, ships as a separate hostable app, helps new users reach first success quickly, proves the product’s capabilities credibly, and exposes first-class product, SDK, and API documentation generated from the codebase.

## Recommendation

Use an in-repo docs portal built with Nextra and render the API reference with Scalar.

This is the best fit for the current repository because:

- the frontend already runs on Next.js App Router under `frontend/`
- the repo already stores meaningful Markdown content under `docs/`
- the backend already generates OpenAPI under `backend/openapi.yaml` and `backend/openapi.json`
- the current product UI already consumes Markdown docs through the frontend build pipeline

The docs site should not be treated as a passive documentation mirror. It should function as:

- the primary public developer onboarding surface
- the canonical technical explanation of how Radioso works
- an acquisition surface for developers evaluating grounded chat and embedded assistant products
- a proof surface with real examples, payloads, and implementation guides

## Non-Goals

- replacing the application dashboard with a docs-first site
- inventing a second source of truth for settings copy
- adding docs versioning before there is a release/versioning requirement
- introducing a separate docs repo
- creating a marketing brochure site detached from real technical substance

## Target Architecture

### Chosen shape

Build the docs portal as a separate hostable app in this repo, not as routes inside `frontend/`.

The existing product frontend should only contain a link in its menu to the docs site. The docs portal should have its own build, hosting target, metadata, and deployment lifecycle.

### Why this shape

- keeps the product app isolated from docs concerns
- avoids coupling public docs traffic to authenticated app providers and dashboard code
- allows docs to be hosted on a dedicated domain such as `docs.radioso.com`
- gives cleaner ownership boundaries for navigation, SEO, and release cadence

### Preferred location

Create a sibling app at the repo root, for example:

- `docs-portal/`

This keeps the docs code clearly separate from `frontend/` while still living in the same repository and sharing CI, branding assets, and generated artifacts.

## Proposed Repo Structure

### Application code

Add a standalone docs app at the repo root:

```text
docs-portal/
  app/
    [[...mdxPath]]/
      page.tsx
    api-reference/
      route.ts
    layout.tsx
  content/
    docs/
      index.mdx
      getting-started/
      guides/
      reference/
      sdk/
      operators/
      _meta.ts
  public/
  next.config.mjs
  package.json
```

### Source-of-truth content

Keep authored long-form docs in the repo root `docs/` directory, but migrate portal-served content into `docs-portal/content/docs/` as the docs app’s canonical publishing tree.

That means:

- `docs/` remains the working area for internal notes, feature plans, and non-portal artifacts when needed
- `docs-portal/content/docs/` becomes the canonical published docs tree
- existing Markdown that should be public gets migrated, not duplicated

## Content Model

### Primary audience lanes

The portal should be organized by task and audience, not by internal module names.

There are three primary audiences:

1. Evaluators deciding whether Radioso solves their problem
2. Builders trying to get to first success fast
3. Operators who need to run, tune, and trust the system

Top-level navigation:

1. Why Radioso
2. Quickstarts
3. Guides
4. API Reference
5. SDK
6. Operators
7. Security
8. Troubleshooting
9. Architecture

### Golden paths

The entire site should be optimized around three golden paths:

1. Embed Radioso on a website
2. Upload documents and ask questions through the API
3. Run Radioso locally in under 5 minutes

If these paths are excellent, the docs will feel alive. If these paths are weak, the portal will read like a static archive.

### Product positioning layer

Before deep reference material, the site should answer:

- What Radioso is
- Why it exists
- How it differs from generic “chat with PDFs” tools
- Why its grounding, citations, workspaces, and embed model matter
- Who it is for
- When not to use it

### Initial page map

#### Why Radioso

- What Radioso is
- Who it is for
- Why grounded answers matter
- How citations and support validation work
- Product architecture at a high level
- Comparison pages and use-case pages

#### Quickstarts

- Run locally in 5 minutes
- Embed on your website
- Upload a document and ask via API
- Use the TypeScript SDK in a minimal app

#### Guides

- Authenticate with session or API token
- Upload documents through the API
- Tune retrieval settings
- Configure ingestion settings
- Use website embed
- Configure anonymous chat
- Work with workspaces and users

#### API Reference

- API overview
- Authentication model
- Interactive endpoint reference from OpenAPI
- Error handling and common status codes

#### SDK

- TypeScript SDK getting started
- Basic usage
- Retrieval settings examples

#### Operators

- Deployment model
- Storage model
- Background document processing
- Performance benchmarking

#### Security

- Token handling
- Public embed safety
- Session model
- Abuse controls

#### Troubleshooting

- Startup failures
- Provider key issues
- Document processing failures
- Retrieval quality debugging

#### Architecture

- Request flow
- Retrieval pipeline
- Document processing lifecycle
- Chat vs deferred execution
- Deployment topology

### Discoverability pages

The site should include explicit acquisition-oriented pages for search and evaluation:

- Embedded AI support widget
- Grounded chat for product documentation
- Self-hosted support agent with workspace context
- AI answers with citations
- Workspace-based team knowledge assistant
- Radioso vs generic chat-over-files tools

These are not fluff pages. They should be technical, honest, and conversion-oriented.

## Existing Content Migration

### Content to migrate into the portal immediately

- `readme.md`
- `docs/assistant-execution-model.md`
- `docs/typescript-sdk-getting-started.md`
- `docs/typescript-sdk-basic-usage.md`
- `docs/typescript-sdk-retrieval-settings.md`
- `docs/performance-benchmarking.md`

This migration should be treated as source harvesting, not one-to-one publishing. Existing docs are inputs to stronger portal pages, not a nav structure to preserve.

### Content to publish in adapted form

The settings docs are useful but currently optimized for inline product UI help. They should become a hybrid source, not raw dumps into the portal.

Use them to build:

- retrieval settings reference pages
- ingestion settings reference pages
- operator guidance pages with examples and defaults

### Duplication issue to resolve first

There are two settings-docs trees:

- `docs/settings-docs`
- `frontend/docs/settings-docs`

The current frontend imports the repo-level docs tree in `frontend/components/dashboard/settings/settings-docs.ts`, which suggests the `frontend/docs/settings-docs` copy is redundant or stale.

Before building the portal:

1. choose one canonical settings-docs source
2. delete or generate the duplicate tree
3. keep the UI and docs portal reading from the same source or from a deterministic transform of that source

This is the most important docs-data cleanup item in the repo.

## Tooling Plan

### Core docs framework

Use `nextra` with `nextra-theme-docs` in the standalone docs app.

Why:

- native fit for Next.js App Router
- file-based content structure
- built-in search
- MDX support for custom components
- low conceptual overhead relative to adding Docusaurus or Astro

### API reference

Use `@scalar/nextjs-api-reference` for `/docs/api-reference`.

Use the generated `backend/openapi.json` as the primary render target. This avoids YAML parsing at request time and aligns with the backend’s existing `generate:openapi` flow.

### Optional follow-on tooling

- `remark-gfm` for richer Markdown tables and callouts if needed
- link checker in CI
- frontmatter/content linting once the docs tree stabilizes

## Concrete Scaffold

### New app name

Create a new top-level app named `docs-portal/`.

### Package manager choice

Use plain `npm`, not a new workspace tool, for the first version.

Reason:

- the repo already has per-app `package.json` files
- there is no root workspace manifest today
- adding a workspace manager is unnecessary scope for a docs app

### Initial file tree

```text
docs-portal/
  app/
    [[...mdxPath]]/
      page.tsx
    api-reference/
      route.ts
    layout.tsx
    page.tsx
  components/
    docs-shell.tsx
    docs-footer.tsx
    logo.tsx
  content/
    docs/
      _meta.ts
      index.mdx
      why-radioso/
        index.mdx
        grounded-answers.mdx
        use-cases.mdx
      quickstarts/
        index.mdx
        run-locally.mdx
        website-embed.mdx
        api-first-success.mdx
      guides/
        authentication.mdx
        document-upload.mdx
        retrieval-tuning.mdx
      sdk/
        typescript-getting-started.mdx
        basic-usage.mdx
      operators/
        deployment.mdx
        document-processing.mdx
      architecture/
        index.mdx
        retrieval-pipeline.mdx
        deployment-topology.mdx
      reference/
        settings/
  lib/
    metadata.ts
    openapi.ts
  public/
    radioso-logo.png
    favicon.ico
  scripts/
    sync-openapi.mjs
  next.config.mjs
  package.json
  tsconfig.json
```

### Initial dependencies

Core runtime:

- `next`
- `react`
- `react-dom`
- `nextra`
- `nextra-theme-docs`
- `@scalar/nextjs-api-reference`

Helpful content support:

- `remark-gfm`

Development:

- `typescript`
- `@types/node`
- `@types/react`
- `@types/react-dom`
- `eslint`
- `eslint-config-next`

### Initial scripts

`docs-portal/package.json` should start with:

```json
{
  "private": true,
  "scripts": {
    "dev": "next dev --port 3001",
    "build": "pnpm run sync:openapi && next build",
    "start": "next start --port 3001",
    "lint": "eslint .",
    "sync:openapi": "node ./scripts/sync-openapi.mjs"
  }
}
```

### OpenAPI sync behavior

The docs app should not generate OpenAPI itself. It should consume the backend-generated spec.

Recommended behavior:

1. run `backend` OpenAPI generation in CI or in a root orchestration step
2. copy `backend/openapi.json` into `docs-portal/public/openapi.json`
3. point Scalar at `/openapi.json`

That keeps the docs app simple and avoids cross-app TypeScript runtime dependencies.

## Runtime Contract

### Environment variables

Keep the first version almost env-free.

Only introduce:

- `DOCS_SITE_URL`
- `RADIOSO_APP_URL`
- `RADIOSO_API_BASE_URL` only if you want absolute examples or runtime-generated links

Avoid backend-only secrets or app session configuration in the docs app.

### Port contract

Use port `3001` locally for the docs app so it does not collide with the existing frontend on `3000`.

### Health contract

Add a simple public health endpoint in the docs app, for example:

- `/health`

That keeps deployment checks consistent with the current backend and frontend hosting model.

## Local Development Plan

### Minimal first step

The docs app should be runnable independently:

```bash
cd docs-portal
pnpm install --filter radioso-docs-portal...
pnpm run dev
```

The local developer experience should make the three golden paths visible immediately from the docs homepage. The first screen should not be a generic docs index.

### Docker development

Do not add the docs app to the existing local Docker stack in phase 1 unless there is a strong reason.

The current local stack already runs:

- Postgres
- backend
- backend worker
- frontend

The docs app does not need any of those to render static prose and API reference from a checked-in OpenAPI artifact.

If Docker support is added later, it should be optional and separate from the product app’s critical path.

## Deployment Contract

### Hosting target

Deploy the docs app as its own Cloud Run service and map it to:

- `docs.radioso.com`

The docs site should be treated as a public product surface, not as internal technical infrastructure. That means launch quality matters: polished metadata, stable URLs, excellent homepage copy, and zero confusing dead ends.

### Container contract

Add a dedicated Dockerfile for the docs app, for example:

- `docs-portal/Dockerfile`

That image should:

- install docs app dependencies
- run `pnpm run build`
- start Next.js in production on port `3001` or `3000`, depending on the chosen container convention

Preferred production convention:

- use container port `3000` in production
- keep `3001` for local development only

That aligns better with the existing frontend service pattern.

### Terraform changes

The current Terraform already provisions:

- backend Cloud Run service
- frontend Cloud Run service
- document worker Cloud Run service

Add:

- a new service account for docs
- a new Cloud Run service for docs
- public invoker IAM for docs
- an output for `docs_url`

Suggested resource naming pattern:

- service account: `${local.service_name}-docs`
- service: `${local.service_name}-docs`

### Terraform variables

Add:

- `docs_image`
- `docs_min_instances`
- `docs_max_instances`
- optionally `docs_site_url`

### DNS and ingress

The docs app should be publicly reachable directly. No dependency on the existing frontend service or rewrite rules should exist.

## CI Plan

### Build sequence

Add a docs job with this execution order:

1. `cd backend && pnpm install --filter radioso-backend... && pnpm run generate:openapi`
2. `cd docs-portal && pnpm install --filter radioso-docs-portal... && pnpm run build`

### Failure conditions

Fail the job when:

- OpenAPI generation fails
- docs build fails
- internal links fail
- required docs content is missing
- golden-path pages are missing

### Nice-to-have checks

- verify `public/openapi.json` matches freshly generated backend output
- verify there is no remaining duplicated settings-docs source after cleanup

## Content Migration Order

### Wave 1

Ship only the content necessary to make the portal useful on day one:

- homepage that explains the product clearly
- three golden-path quickstarts
- SDK quickstart
- API reference
- why-radioso positioning pages
- retrieval settings overview
- deployment overview
- one architecture overview page

### Wave 2

- ingestion settings reference
- workspace and account guides
- website embed guide
- security and token guide
- troubleshooting
- comparison and use-case pages
- end-to-end diagrams and payload examples

### Wave 3

- architecture deep dives
- operator runbooks
- release notes or changelog
- demo-backed proof pages

## Proof Strategy

The docs site should prove Radioso works, not merely assert it.

Every golden path should include:

- a copy-paste walkthrough
- a real request example
- a real response example
- expected outcome screenshots or diagrams
- the most common failure mode and how to recover

The site should also include:

- at least one architecture diagram
- at least one embed walkthrough with visible result
- at least one end-to-end API example from upload to answer

## Source-of-Truth Rules

## Source-of-Truth Rules

### Portal pages

Published docs should live in `docs-portal/content/docs/`.

This should become the canonical published-doc source. The root `docs/` directory may still exist for internal planning and non-public artifacts, but public docs should not have two editorial homes.

### Raw product/settings copy

UI support copy should live in a single canonical source and be transformed into:

- product inline help
- docs reference pages

The current duplication between `docs/settings-docs` and `frontend/docs/settings-docs` should not be carried into `docs-portal/`.

### API reference

`backend/openapi.json` remains canonical. `docs-portal/public/openapi.json` is a build artifact, not an authored file.

## Menu Link Contract

The product frontend should only expose one link to the docs portal.

That link should:

- be configured from a single public environment variable if the hostname may differ by environment
- default cleanly in development, for example `http://localhost:3001`
- open in the same tab unless there is a product reason not to

This is the only required change in the existing frontend.

## Success Metrics

The docs portal should be considered successful when a new developer can:

1. understand what Radioso does within 60 seconds
2. complete one golden path in under 15 minutes
3. find the relevant API endpoint or SDK call in under 2 minutes
4. understand how grounding and citations work without reading backend code
5. decide whether Radioso fits their use case without scheduling a call

## Acceptance Criteria

The scaffold is complete when:

- `docs-portal/` runs independently on a local port
- the landing page explains the product and offers the three golden paths
- `/api-reference` renders from generated OpenAPI
- at least five high-value pages are migrated
- at least three golden-path quickstarts exist
- the docs app can be built as its own production image
- Terraform can provision it as a separate public service
- the product app only links to it and does not embed its routes

## Integration Details

### Frontend integration

Implementation should preserve the existing product app behavior by avoiding docs code in `frontend/`.

The only frontend change should be a menu link that points to the standalone docs host.

Example targets:

- `https://docs.radioso.com`
- `https://radioso.com/docs` if reverse-proxied externally to the docs app

No docs routes, docs layout, or docs content handling should be added to the existing product frontend.

### OpenAPI integration

Use the backend’s existing script:

- `backend/scripts/generateOpenApi.ts`
- `backend/package.json` script `generate:openapi`

The docs app build should depend on fresh OpenAPI output. The docs build must not silently ship stale API reference content.

### Search

Start with Nextra’s default full-text search.

Only add Algolia or external indexing if:

- docs volume grows materially
- public search quality becomes a visible problem
- you need analytics-backed search tuning

### Analytics and feedback

Do not add product analytics, thumbs voting, or comments in the first implementation.

Add them only after:

- the core information architecture is stable
- there is a real review workflow for feedback intake

## SEO and Publishing

### URL strategy

Use one of these in order of preference:

1. `docs.radioso.com`
2. `radioso.com/docs`

For implementation inside this repo, prefer `docs.radioso.com` and host the standalone docs app there.

### Metadata requirements

Each published page should include:

- title
- description
- canonical path
- Open Graph metadata

### Sitemap and robots

Generate a docs sitemap and ensure the docs surface is indexable by default, except for any internal-only operator pages if those remain public-in-repo but should not be search-indexed.

## CI and Quality Gates

Add a docs pipeline with the following checks:

1. generate OpenAPI
2. build the standalone docs app
3. fail on broken internal links
4. fail on duplicate slugs
5. optionally fail on missing required frontmatter

Minimum acceptable gate for the first version:

- `backend` OpenAPI generation succeeds
- `docs-portal` build succeeds
- no broken internal links

## Rollout Plan

### Phase 1: Foundation

- scaffold `docs-portal/`
- add Nextra dependencies there
- add docs layout, navigation, and a non-generic homepage
- add Scalar API reference route
- verify local build and routing

### Phase 2: Content migration

- write the three golden-path quickstarts
- write the why-radioso pages
- migrate SDK and getting-started docs
- migrate assistant execution model
- create operator docs skeleton
- rewrite settings docs into operator-facing reference pages

### Phase 3: Source-of-truth cleanup

- unify duplicated settings-docs trees
- document the canonical authoring workflow
- ensure UI help copy and portal docs derive from the chosen source

### Phase 4: Quality hardening

- add docs CI gates
- add link checking
- add sitemap and metadata polish
- review public wording and navigation labels

### Phase 5: Public launch

- deploy under chosen domain
- validate indexing
- validate API reference freshness
- announce docs as the primary public documentation surface
- validate that the homepage and quickstarts are good enough to send prospects to cold

## Risks

### Separate app drift

A standalone docs app can drift visually or semantically from the product if branding tokens, logos, or terminology are copied manually. Shared assets and explicit editorial ownership are needed.

### Duplicate Markdown sources

Two settings-docs trees will cause drift and editorial confusion if not resolved before launch.

### Stale API reference

If docs build does not force OpenAPI generation, the API reference will diverge from backend reality.

### Mixed audiences in one tree

Operator docs, product docs, and developer docs can easily get mixed together. The nav should separate them intentionally from the start.

### Migration trap

If the team treats existing docs as pages to port instead of raw inputs to rewrite, the portal will inherit the current documentation weaknesses and feel incremental rather than category-defining.

## Implementation Checklist

- [ ] Create `docs-portal/`
- [ ] Add Nextra to `docs-portal/package.json`
- [ ] Add standalone docs app layout
- [ ] Add `docs-portal/content/docs`
- [ ] Add initial `_meta` navigation
- [ ] Add homepage with product positioning and golden paths
- [ ] Add three golden-path quickstarts
- [ ] Add Scalar route for API reference
- [ ] Wire docs build to fresh OpenAPI output
- [ ] Migrate existing SDK and product docs
- [ ] Add proof artifacts: diagrams, payloads, screenshots
- [ ] Add discoverability pages for major use cases and comparisons
- [ ] Unify settings-docs source of truth
- [ ] Add link and docs build checks in CI
- [ ] Add sitemap and metadata polish
- [ ] Add one outbound docs link in the product frontend menu

## Final Recommendation

Build the first version as a separate hostable app in this repo and keep the docs portal out of `frontend/`.

The immediate execution priorities should be:

1. scaffold `docs-portal/` with Nextra
2. ship API reference from generated OpenAPI with Scalar
3. write the three golden-path quickstarts and a strong homepage
4. eliminate the duplicate settings-docs trees
5. migrate the current high-value docs into a task-based information architecture
6. add proof and discoverability layers so the site works as a developer acquisition surface

That gets Radioso to a credible, differentiated developer surface with clean deployment boundaries and keeps the product frontend nearly untouched.
