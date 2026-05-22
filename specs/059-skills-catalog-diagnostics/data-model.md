# Data Model: Skills Catalog Diagnostics

No database schema changes are required.

The entities below are static or in-memory contract entities for this feature.

## Skill Catalog Entry

Describes one product-facing skill.

Fields:

- `name`: Stable machine-readable skill identifier, such as `retrieval.answer`.
- `displayName`: Short human-readable name.
- `description`: Concise purpose statement.
- `owner`: Product/module owner such as `assistant`, `retrieval`, `documents`, `mcp`, or `platform`.
- `executionClass`: `interactive`, `deferred`, or `administrative`.
- `availability`: Current catalog-visible state.
- `supportedCallers`: Supported caller surfaces such as `assistant`, `retrieval_api`, `sdk`, `mcp`, `dashboard`, or `public_embed`.
- `requiredCapabilities`: Shared capability names required to use the skill.
- `contractReferences`: Existing contracts or surfaces callers should use today.
- `diagnostics`: Whether diagnostics are defined, unavailable, or strategy-aware.

Validation rules:

- `name` must be stable and unique.
- `requiredCapabilities` must use known shared capability names.
- `contractReferences` must not imply generic skill execution.
- unavailable entries must not expose secret provider configuration or deployment internals.

## Skill Availability

Describes whether a skill is visible and usable in the current composition.

States:

- `available`: Skill is present in the current catalog and points to an existing callable contract. Capability policy affects this state only for catalog entries whose current execution path enforces the same policy.
- `forbidden`: Skill exists, but capability policy denies the caller.
- `unavailable`: Skill exists, but current composition does not provide it.

Validation rules:

- `forbidden` may include a stable reason code.
- `unavailable` may include a stable reason code.
- Neither state may reveal secrets or private deployment configuration.

## Skill Contract Reference

Points callers to the current stable surface for using a skill.

Fields:

- `kind`: `http`, `sdk`, `mcp_tool`, or `documentation`.
- `label`: Short label for display or documentation.
- `method`: HTTP method when applicable.
- `path`: HTTP path, SDK method, MCP tool name, or documentation path.

Validation rules:

- HTTP references must point to existing or newly added public contracts.
- SDK and MCP references must match documented public names.

## Skill Diagnostic Definition

Defines metadata that future skill executions should emit.

Fields:

- `skillName`: Selected skill.
- `strategy`: Selected strategy when applicable.
- `selectionMode`: `deterministic` or `probabilistic`.
- `selectionReason`: Stable reason code or concise explanation when available.
- `selectionConfidence`: Numeric confidence when available.
- `callerSurface`: Surface that requested or orchestrated the skill.
- `capabilityChecks`: Capability decisions that materially affected execution.
- `parameters`: Non-sensitive parameters that materially affected execution.
- `fallback`: Fallback path when used.
- `outcome`: `success`, `unsupported`, `forbidden`, `failed`, or `skipped`.
- `error`: Stable error code when execution fails or is unsupported.
- `evidence`: Evidence/support metadata when the skill is evidence-backed.

Validation rules:

- deterministic skills may omit `strategy`, `selectionConfidence`, and `evidence`.
- retrieval-backed skills may include retrieval-specific metadata.
- diagnostics must not expose document content beyond existing evidence contracts.
- diagnostics must not expose secrets, tokens, or provider payloads.

## Retrieval Diagnostic Metadata

Specialized diagnostic metadata for future strategy-aware retrieval skills.

Fields:

- `queryShape`: Shape inferred for the query, such as definition lookup, event date lookup, policy answer, exploratory summary, or follow-up grounding.
- `retrievalStrategy`: Selected retrieval strategy.
- `candidateSourceSummary`: Counts or summaries of vector, lexical, metadata, and reranked candidates.
- `ranking`: Ranking or reranking choices that materially affected selected context.
- `evidenceStatus`: Whether evidence was found, missing, partial, or not applicable.
- `groundingOutcome`: Stable grounded-answer outcome.

Validation rules:

- retrieval metadata is optional for non-retrieval skills.
- query shape and strategy values must be stable enum values before they are documented as public.
