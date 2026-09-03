# Contributing to Radioso

Thanks for wanting to work on Radioso. This guide covers what a human contributor needs: getting a local stack running, the tests each package expects you to pass, and how to shape a pull request so it can be reviewed and merged.

Radioso's open-source edition is licensed under Apache 2.0. The files under [`ee/`](./ee) are the commercial Enterprise Edition and are covered by a separate license — contributions to that directory are handled differently, so open an issue first if that is where your change lands.

> There is a companion file, [`AGENTS.md`](./AGENTS.md), written for AI coding agents. It carries the same commands plus repo-specific conventions and context-budget rules. Humans are welcome to skim it, but everything you need to contribute is here.

## Prerequisites

- **Node.js 24** and **pnpm** (this is a pnpm workspace; run `pnpm` from the repo root, never `npm install` inside a package).
- **Docker** with Compose, for the local stack and for the containerized checks. On Windows, use Docker Desktop with Linux containers.
- A provider API key (for example OpenAI) if you want chat and document processing to run end to end. You add it in the app under **Settings → Credentials** after the stack is up.

## Run the stack locally

On macOS or Linux:

```bash
./run-dev.sh
```

On Windows, open PowerShell or Command Prompt in the repository root:

```powershell
.\run-dev.cmd
```

This brings up the backend API, the document worker, the frontend, and PostgreSQL with `pgvector` in Docker. The frontend serves on `http://127.0.0.1:3000` and the backend on `http://127.0.0.1:8080`. A cold first boot installs dependencies inside the containers and can take several minutes; the runner prints a heartbeat while it works.

To run pieces directly instead of the full stack:

```bash
cd backend
pnpm run dev          # API server
pnpm run dev:worker   # document worker
```

```bash
cd frontend
pnpm run dev
```

## Tests

Run the tests for the area you changed. Each package owns its own suite.

**Backend** — Vitest, Supertest, and contract tests:

```bash
cd backend
pnpm test              # everything
pnpm run test:unit
pnpm run test:integration
pnpm run test:contract
```

Backend work is test-driven: write the failing test first, then make it pass.

The integration suite changes database contents and only runs against a database whose name ends in `_test` and carries Radioso's disposable-test marker. `pnpm run ci:local` creates and marks a fresh PostgreSQL container for you. For a focused manual run, point `INTEGRATION_DATABASE_URL` at a dedicated test database, acknowledge its exact name, and mark it once before running tests:

```bash
cd backend
export INTEGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/radioso_test
export RADIOSO_INTEGRATION_DATABASE_NAME=radioso_test
pnpm run test:integration:prepare
unset RADIOSO_INTEGRATION_DATABASE_NAME
pnpm run test:integration
```

The guard rejects an application database that resolves to the same live PostgreSQL database, an unmarked database, and names without the `_test` suffix. Use a disposable PostgreSQL instance: the suite creates and removes fixtures, schemas, generated databases, and extensions. The CI harness's test runner is cluster-privileged for that migration coverage, but its credential exists only inside the throwaway container.

**Frontend** — Vitest for logic and Playwright for user journeys:

```bash
cd frontend
pnpm test
pnpm run test:e2e
pnpm run lint
```

Keep frontend unit tests on state transitions, data transforms, API adapters, and routing logic. Reach for Playwright for anything a user sees; don't assert on markup, class names, or cosmetic copy.

**Other packages** each have their own `pnpm test` — the TypeScript SDK (`typescript-sdk/`), the MCP server (`packages/radioso-mcp-server/`), the docs portal (`docs-portal/`), and the Enterprise Edition packages (`ee/`).

If your change alters a public API, the OpenAPI contract, an SDK or MCP contract, a connector contract, or a worker payload, regenerate the committed SDK snapshot in the same change:

```bash
cd typescript-sdk
pnpm run sync
```

Documentation is part of the product. If your change affects setup, auth, APIs, ingestion, retrieval settings, SDK usage, or MCP usage, update the relevant docs under `docs/` or `docs-portal/content/` in the same pull request.

## Before you open a pull request

GitHub CI is manual here, so run the local check first. It builds and tests the workspace against your merge base:

```bash
pnpm run ci:local -- origin/main
```

Use `pnpm run ci:local -- --all` for changes that touch many areas, and paste the result into the pull request body.

## Commit and pull request format

- Use [Conventional Commits](https://www.conventionalcommits.org/) for messages, such as `feat: add retrieval setting` or `fix: handle empty uploads`.
- Keep a pull request focused on one change. Extraction-only refactors are easier to review when they are separate from behavior changes.
- Fill in the pull request template: what changed, why, how you tested it, and the `ci:local` result.

## Reporting bugs and proposing features

Open a GitHub issue using the bug-report or feature-request template. For anything security-sensitive, do not open a public issue — follow [SECURITY.md](./SECURITY.md) instead.

By contributing, you agree to abide by the [Code of Conduct](./CODE_OF_CONDUCT.md).
