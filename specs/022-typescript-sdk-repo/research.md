# Research: Radioso TypeScript SDK

## Decision 1: Start with an in-repo SDK package, not a separate repository

- **Decision**: Build the first SDK release inside `typescript-sdk/` in the main repository.
- **Rationale**: The dominant risk is contract drift, not repository ownership. Keeping the SDK in-repo lets the package evolve alongside the code-first OpenAPI contract and backend validation without inventing a multi-repo sync workflow before the package surface is stable.
- **Alternatives considered**:
  - Separate repository immediately: rejected because it introduces versioning, release, and contract-sync overhead before the package surface is proven.
  - No package, just publish raw OpenAPI: rejected because it leaves streaming chat ergonomics and error normalization unsolved for consumers.

## Decision 2: Use a generated core plus a handwritten streaming layer

- **Decision**: Drive standard request and response operations from the OpenAPI contract, but implement streaming chat consumption in a focused handwritten adapter.
- **Rationale**: Generation is the safest way to keep ordinary request/response operations aligned with the backend contract. Streaming chat is the main workflow where raw generated clients usually leave too much low-level parsing burden on consumers.
- **Alternatives considered**:
  - Fully handwritten SDK: rejected because it increases maintenance cost and contract-drift risk.
  - Fully generated SDK with no handwritten surface: rejected because it does not adequately solve typed SSE ergonomics.

## Decision 3: Normalize token-auth contract metadata before SDK generation

- **Decision**: Treat backend OpenAPI security metadata as a blocking foundation item and correct token-auth modeling before generating the SDK surface.
- **Rationale**: `backend/src/app/http/openapi/document.ts` currently aliases `bearerAuthScheme` to the session cookie security scheme, which is misleading for token-based SDK consumers. The SDK should not be generated from an ambiguous or wrong auth contract.
- **Alternatives considered**:
  - Generate from the current contract and patch auth semantics in the SDK manually: rejected because it duplicates and obscures the source of truth.
  - Ignore auth metadata and rely only on README documentation: rejected because it weakens both SDK correctness and future contract validation.

## Decision 4: Narrow v1 to token-based external operations

- **Decision**: The first SDK release covers only documented operations intentionally exposed for token-based external use.
- **Rationale**: This keeps the first release coherent for external developers and avoids dragging browser-session, admin-only, or internal flows into a package that should be externally consumable.
- **Alternatives considered**:
  - Full parity with all documented routes: rejected because many routes are designed around browser sessions or first-party UI behavior.
  - Chat-only SDK: rejected because documents, workspace-scoped settings, search/chat history, and related token-auth workflows are part of a credible external integration surface.

## Decision 5: Make contract refresh a first-class workflow

- **Decision**: Add a dedicated SDK sync script and validation flow that refresh package contract snapshots from `backend/openapi.json` and fails when the SDK surface drifts from the backend contract.
- **Rationale**: A useful SDK is not only generated once; maintainers need a repeatable refresh loop. This needs to be explicit from the first release rather than treated as future cleanup.
- **Alternatives considered**:
  - Manual copy/update workflow: rejected because it is easy to skip and hard to review.
  - Regenerate only at release time: rejected because drift should be caught earlier in normal feature development.
