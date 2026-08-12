# US3 Backend Delivery Plan

## Technical Context

Extend the TypeScript/Express operator-copilot module with copilot-owned proposal
persistence and a narrow proposal-adapter port. PostgreSQL remains the system of
record; Kysely schema types are updated by hand because the requested workflow
does not run generators. Runtime wiring belongs in application composition and
dependency assembly. The existing directive authoring and agent-management
public services remain the only mutation paths.

## Boundaries

- `operatorCopilot`: proposal state machine, repository port, draft-only tools,
  SSE/card presentation, and HTTP orchestration. It must not write target
  configuration during a turn.
- Proposal adapters: copilot-owned consumer port, implemented against the
  public agent/directive services. They own target version, preview and
  apply-if-current semantics.
- Composition: creates concrete adapters and combines their tool descriptors;
  it owns no proposal rules.
- Repository: maps broad database strings/JSON values to narrow domain types.

## Constitution Check

- Approved spec and contracts exist. Backend TDD uses focused Vitest tests only.
- The change uses Node.js, PostgreSQL, and existing LLM/provider resolution.
- No secrets or new configuration are introduced.
- OpenAPI code registry is updated; generated artifacts are intentionally not
  regenerated per the requested workflow.
- No document-worker, AMQP payload, retry, queue-test, or queue-doc change is
  needed: proposal drafts and application are synchronous API operations.
- Prompt asset remains under `backend/prompts/`.

## Delivery Slices

1. Add failing unit tests for proposal drafting, persistence association, SSE,
   preview/apply/dismiss outcomes, permissions, and adapter staleness.
2. Add the migration, handwritten Kysely table type, repository mapping, and
   copilot proposal contracts/service.
3. Implement draft-only tools and adapter implementations; wire production and
   in-memory test composition.
4. Add routes/OpenAPI/coverage/prompt updates, run focused tests and the
   architecture-boundary verifier, then review.
