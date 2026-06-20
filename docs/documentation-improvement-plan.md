---
title: "Documentation Improvement Plan"
description: "Identifies weak areas in docs and docs-portal and prioritizes rewrites for architecture, operators, and practical user guides grounded in code."
last_updated: 2026-05-04
---

# Documentation Improvement Plan

This plan focuses on the weakest documentation in `/docs` and `/docs-portal` as of 2026-04-23.

## What is weak today

The main problem is not missing files. It is missing depth in the files that matter most once someone tries to run or operate the system.

The thinnest pages are concentrated in a few areas:

- docs portal architecture pages
- docs portal operator pages
- practical guides for authentication, document upload, and retrieval tuning
- the docs index in `docs/`, which does not explain how the documentation set is organized

Many of those pages currently stop after one or two summary paragraphs. That leaves readers without the operational details they need once they move past the first quickstart.

## Source of truth

Rewrites should stay grounded in code and setup behavior, not product assumptions.

Primary implementation sources:

- local bootstrap: `run-dev.sh`, `scripts/bootstrap/`
- API and worker runtime: `backend/src/runtime/`
- HTTP contracts: `backend/src/app/http/routes/`
- document ingestion and processing: `backend/src/modules/documents/services/`
- retrieval pipeline: `backend/src/modules/retrieval/services/`
- auth and session behavior: `backend/src/modules/auth/`
- deployment topology: `infra/terraform/`
- runtime configuration: `.env.example`, `backend/src/app/config/env.ts`

## Rewrite priorities

### Priority 1: architecture and operator pages

These are the most visibly incomplete pages in the docs portal and they should explain the system at an operator level.

- `docs-portal/content/architecture/retrieval-pipeline.mdx`
- `docs-portal/content/architecture/document-processing-lifecycle.mdx`
- `docs-portal/content/architecture/deployment-topology.mdx`
- `docs-portal/content/operators/document-processing.mdx`
- `docs-portal/content/operators/deployment.mdx`

Expected outcome:

- explain the request path and worker path clearly
- show which components are stateful versus stateless
- call out the main runtime flags and production contracts
- describe failure modes readers will actually hit

### Priority 2: practical user guides

These pages should help someone do real work, not just define terms.

- `docs-portal/content/guides/authentication.mdx`
- `docs-portal/content/guides/document-upload.mdx`
- `docs-portal/content/guides/retrieval-tuning.mdx`

Expected outcome:

- explain when to use sessions, workspace tokens, or public embed access
- describe what happens after upload and why processing status matters
- give a tuning order for retrieval settings that matches the implemented pipeline

### Priority 3: docs navigation and maintenance

- expand `docs/README.md`
- keep links between `/docs` and `/docs-portal` obvious
- treat `docs/settings-docs/` as canonical setting copy, not a duplicate writing surface

## Writing rules for follow-up passes

- prefer source-backed explanations over aspirational language
- explain operator consequences, not only architecture
- include failure checks and verification steps
- avoid duplicating full API reference content when a guide should instead explain workflow
- update docs when bootstrap, auth, ingestion, retrieval settings, or deployment contracts change
