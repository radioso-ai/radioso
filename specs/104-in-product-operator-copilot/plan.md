# Operator Copilot Backend Delivery Plan

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

## US1/US2 Reader Completion Slice (2026-08-18)

### Goal

Complete the approved family-reader contract rather than add a new tool family:
`agent_configuration` must cover agent discovery and use the redacting
`AgentConfig` projection, including authored directives; `routine_definition`
must cover both per-agent routine discovery and a targeted portable-Markdown
read.

### Boundaries

- `operatorCopilot/tools.ts` owns the consumer-shaped tool inputs, bounded
  outputs, and safe summary projections. It must not read repositories directly.
- `agents/public.ts` continues to own the `AgentConfig` serializer and its
  portability/redaction rules. Agent discovery uses a dedicated persisted-only
  service read so opening Ray cannot bootstrap a default agent.
- `routines/public.ts` continues to own routine listing, targeted reads, and the
  portable-Markdown projection. The copilot composes those public operations.
- `app/composition/copilotToolCatalog.ts` remains assembly-only. Its dependency
  type expands to the already-public service methods; no product rule moves into
  composition.

### Constitution Check

- The approved spec already requires this behavior in FR-005 and US2 acceptance
  scenario 1; the slice introduces no new product scope.
- Backend TDD is mandatory: focused tests fail before implementation and cover
  list/detail behavior, directive inclusion, secret redaction, bounded payloads,
  workspace-scoped service calls, and entity-link behavior.
- No secrets or configuration are introduced. The existing `AgentConfig`
  serializer remains the single redaction authority.
- No HTTP, OpenAPI, SDK, MCP, connector, worker, AMQP payload, retry, database,
  or queue contract changes are required.
- Existing copilot tool activity/audit telemetry covers the expanded code paths;
  no new event type, metric, or high-cardinality field is warranted.
- Operator documentation will state that Ray can discover agents, directives,
  and routines; no settings documentation changes are needed.

### Delivery Slices

1. Add failing US1 reader tests for agent discovery, projected configuration,
   directive visibility, secret redaction, routine listing, targeted routine
   reads, bounding, and entity links.
2. Expand the existing family readers through public agent/routine services and
   update the catalog dependency types.
3. Update operator documentation and the catalog coverage assertions where
   needed, then run focused tests, backend build/type validation, and review.
4. Apply senior-review corrections: branch discovery from targeted reads,
   retain stable directive/routine ids, return portability diagnostics instead
   of throwing, and make list/content budgets explicit without slicing portable
   Markdown.
5. Make agent discovery explicitly selectable even on an agent page, model
   list/detail outputs as a discriminated union, and pair bounded directive
   summaries with counts and a targeted full-detail read.
