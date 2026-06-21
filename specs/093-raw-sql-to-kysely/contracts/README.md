# Contracts: Raw SQL → Kysely

**Feature**: 093-raw-sql-to-kysely

## Cross-service contract impact: NONE

This migration is internal to the backend persistence layer. It changes **no**
cross-service contract:

- **HTTP / OpenAPI** (`backend/src/app/http/openapi/document.ts`, `backend/openapi.yaml`,
  `backend/openapi.json`): unchanged. No route, request, or response shape changes.
- **TypeScript SDK** (`typescript-sdk/`): unchanged.
- **MCP server** (`packages/radioso-mcp-server/`): unchanged.
- **Connector contracts** (`packages/connector-api/`): unchanged.
- **Worker payloads / AMQP queue messages**: unchanged. Document-worker dispatch, retry
  semantics, and queue payloads are untouched; the job-claim repositories preserve their
  `FOR UPDATE SKIP LOCKED` behavior, so queue semantics are identical.

The **message-queue impact review** required by the constitution is therefore: *no
queue, dispatch, retry, or payload changes; only the SQL used to read/claim/update rows
behind unchanged repository ports changes.*

## Internal contract that DOES change (and is guarded)

- **Repository injection type**: repositories are injected a Kysely executor
  (`Db = Kysely<DB> | Transaction<DB>`) instead of `Database`. This is an internal
  composition detail wired in `backend/src/app/server/dependencyBuilders.ts`; the
  `*RepositoryPort` interfaces that domain modules depend on do **not** change.
- **Generated schema file**: `backend/src/shared/infra/kysely/schema.ts` is a generated
  artifact with a CI drift check (`db:types:check`), analogous to `schema.sql` /
  `db:schema:check`.

## Verification artifacts

- Negative compile test proving a bad column name fails type-checking (SC-003).
- Retrieval parity fixture (chunk IDs + ordering + scores) for SC-004.
- Boundary-lint rule output showing zero raw-SQL violations (SC-002).
