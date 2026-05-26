# Docs

This directory holds source material for operators, SDK users, and internal contributors. Some of it is published directly. Some of it supports the docs portal or settings UI.

Before creating or revising documentation in this repo, read [Document Writer Prompt](./document-writer-prompt.md) and follow it. That brief is the default writing standard for `readme.md`, `docs/`, `docs-portal/content/`, and settings docs that feed the product UI.

## Start here

- [Documentation Improvement Plan](./documentation-improvement-plan.md) - current audit of thin docs and the rewrite priorities
- [Code Map](./architecture/code-map.md) - stable map from product areas to owners, entry points, tests, and related docs
- [Agent Context Workflow](./agent-context-workflow.md) - lightweight workflow and `.context/` template for low-context feature starts
- [OSS And SaaS Observability](./oss-saas-observability.md) - runtime flags, `/metrics`, and optional PostHog or Sentry adapters
- [Self-hosting Operations](../docs-portal/content/operators/self-hosting-operations.mdx) - backup, restore, upgrade, and worker error practices
- [Assistant Execution Model](./assistant-execution-model.md) - why interactive chat and deferred work stay separate
- [Architecture Extension Points](./architecture-extension-points.md) - supported module boundaries, default composition, and extension rules
- [API Contract Workflow](./api-contract-workflow.md) - backend OpenAPI, SDK, and MCP generated artifact update flow
- [Website Crawler Provider](./website-crawler.md) - OSS crawler provider port and document crawl API
- [Radioso Skills RFC](./radioso-skills-rfc.md) - vocabulary and direction behind the implemented read-only skills catalog
- [MCP Client Setup](./mcp-client-setup.md) - current MCP client connection patterns and constraints

## TypeScript SDK

- [Getting Started](./typescript-sdk-getting-started.md)
- [Basic Usage](./typescript-sdk-basic-usage.md)
- [Retrieval Settings](./typescript-sdk-retrieval-settings.md)

The SDK guides cover the current in-repo package at [`typescript-sdk/`](../typescript-sdk/).

## Settings doc sources

`docs/settings-docs/` contains the canonical setting descriptions that feed the product UI. Keep those pages aligned with the actual request and validation contracts in `backend/src/app/http/routes/settingsRoutes.ts` and the corresponding settings domain modules.
