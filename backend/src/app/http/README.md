# Backend HTTP Surface

The HTTP layer owns Express routes, request validation, authentication and
permission middleware, response presentation, and OpenAPI registration.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).

## Boundaries

HTTP knows about transport shape: request params, request bodies, response
status codes, headers, route-level auth, presenters, and OpenAPI metadata.

HTTP should not own domain decisions, queue selection, retrieval ranking,
provider behavior, storage adapter logic, or product workflow orchestration.

## Read First

- `routes/`: route handlers and route-specific schemas.
- `schemas/`: shared HTTP validation schemas.
- `presenters/`: response mapping from domain/service values to API payloads.
- `middleware/`: auth, permission, session, rate limit, and validation
  middleware.
- `openapi/`: OpenAPI document and path registration.
- `shared/`: small HTTP helpers shared across route groups.

## Route Pattern

Keep route handlers readable top-to-bottom:

1. Authenticate and authorize with middleware.
2. Validate request input with Zod schemas.
3. Call the owning module service or public surface.
4. Map the result through a presenter when response shape is non-trivial.
5. Register or update OpenAPI and contract tests for public API changes.

If route code starts owning mapping, trace formatting, audit metadata, or
persistence details, extract a named helper or move the behavior into the
owning module.

## Contract Checklist

For public API changes, review:

- `openapi/`
- route schemas and presenters
- backend contract tests
- TypeScript SDK sync and tests
- MCP contracts if MCP exposes the same behavior
- docs and docs portal pages that describe the API

## Tests

Focused starting points:

- `cd backend && pnpm run test:contract`
- `cd backend && pnpm run test:integration`
- `pnpm run check:api-contracts`

Use route-specific unit or integration tests when changing auth, validation, or
presenter behavior.
