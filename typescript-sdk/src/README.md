# TypeScript SDK Internals

The SDK owns the first-party TypeScript client surface for Radioso APIs,
including generated API types, HTTP request handling, errors, configuration, and
streaming helpers.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../docs/architecture/code-map.md).

## Boundaries

The SDK knows about public API contracts and client ergonomics.

The SDK should not define backend behavior or carry product rules that are not
part of the public contract. Backend contract changes should flow through the
API contract workflow before SDK behavior is updated.

## Read First

- `index.ts`: exported SDK surface and client composition.
- `core/config.ts`: client configuration.
- `core/http.ts`: HTTP transport and request behavior.
- `core/errors.ts`: SDK error mapping.
- `generated/client.ts` and `generated/types.ts`: generated API surface.
- `resources/`: hand-written token-authed authoring resources (routines,
  directives, context variables, skills, MCP), composed into the client in
  `index.ts`. `operationTypes.ts` extracts request/response types for endpoints
  with inline (unnamed) OpenAPI schemas.
- `streaming/chatStream.ts`: streaming chat helpers.

## Common Change Paths

- API contract changes: update backend OpenAPI first, run SDK sync, then adjust
  public exports and tests.
- Error behavior: keep `core/errors.ts` aligned with backend response shape.
- Streaming behavior: update `streaming/chatStream.ts` and chat stream docs.
- Public surface changes: update `index.ts`, README examples, and docs portal SDK
  pages.

## Tests

Focused starting points:

- `cd typescript-sdk && pnpm run sync`
- `cd typescript-sdk && pnpm run build`
- `cd typescript-sdk && pnpm test`

Run `pnpm run check:api-contracts` from the repo root when backend API contracts
change.
