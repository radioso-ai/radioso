---
title: "Docs"
description: "Guide to documentation sources for operators, SDK users, and contributors with links to key starting points and architecture materials."
last_updated: 2026-09-04
---

# Docs

This directory holds source material for operators, SDK users, and internal contributors. Some of it is published directly. Some of it supports the docs portal or settings UI.

Before creating or revising documentation in this repo, read the [Docs Style Guide](./document-writer-prompt.md) and follow it. That guide is the writing standard for `readme.md`, `docs/`, `docs-portal/content/`, and settings docs that feed the product UI.

## Start here

- [Code Map](./architecture/code-map.md) - stable map from product areas to owners, entry points, tests, and related docs
- [Topic Census](./architecture/topic-census.md) - how Audience Pulse computes an exact topic distribution over visitor questions and tracks topic identity across analyses
- [Agent Context Workflow](./agent-context-workflow.md) - lightweight workflow and `.context/` template for low-context feature starts
- [Lint And Dead-Code Gates](./code-quality-gates.md) - what the workspace lint run and the dead-code ratchet check, and what to do when one fails
- [OSS And SaaS Observability](./oss-saas-observability.md) - runtime flags, `/metrics`, and optional PostHog or Sentry adapters
- [Monitoring And Alerts](./monitoring-alerts.md) - which signals a deployment exposes, and example Prometheus alert rules
- [Monitoring On Google Cloud](./monitoring-google-cloud.md) - Terraform alert policies, uptime check, and Cloud Run health probes
- [Ops Event Feed](./ops-event-feed.md) - push signups, completed conversations, and errors to a signed webhook
- [Self-hosting Operations](../docs-portal/content/operators/self-hosting-operations.mdx) - backup, restore, upgrade, and worker error practices
- [Assistant Execution Model](./assistant-execution-model.md) - why interactive chat and deferred work stay separate
- [Architecture Extension Points](./architecture-extension-points.md) - supported module boundaries, default composition, and extension rules
- [API Contract Workflow](./api-contract-workflow.md) - backend OpenAPI, SDK, and MCP generated artifact update flow
- [Human Takeover](./human-takeover.md) - operator API and ownership behavior for human-owned conversations
- [Embedding Coverage](./embedding-coverage.md) - read how much of a workspace is indexed, repair what is missing, and verify vector search agrees
- [Website Crawler Provider](./website-crawler.md) - OSS crawler provider port and document crawl API
- [Website Embed CDN](./website-embed-cdn.md) - how the embed widget assets are served from the CDN
- [Slack Channel](./slack-channel.md) - Slack setup, self-host manifest, data flow, and curated-knowledge boundary
- [Webhook Skills](./webhook-skills.md) - configure agents to call your webhooks as skills
- [Slack Post Skills](./slack-skills.md) - configure agents to post to Slack as a skill
- [Customer Email Skills](./customer-email-skills.md) - workspace outbound email connections and email skills
- [External Skills via MCP](./external-skills.md) - connect an MCP server and turn its published tools into agent skills
- [Radioso Skills RFC](./radioso-skills-rfc.md) - vocabulary and direction behind the implemented read-only skills catalog
- [MCP Client Setup](./mcp-client-setup.md) - current MCP client connection patterns and constraints

## TypeScript SDK

- [Getting Started](./typescript-sdk-getting-started.md)
- [Basic Usage](./typescript-sdk-basic-usage.md)

The SDK guides cover the current in-repo package at [`typescript-sdk/`](../typescript-sdk/).

## Settings doc sources

`docs/settings-docs/` contains the canonical setting descriptions that feed the product UI. Keep those pages aligned with the actual request and validation contracts in `backend/src/app/http/routes/settingsRoutes.ts` and the corresponding settings domain modules.
