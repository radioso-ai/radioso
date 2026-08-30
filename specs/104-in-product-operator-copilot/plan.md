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

## Wave 3 Knowledge-Base Ownership Slice (#1049 / #1051, 2026-08-30)

### Goal

Close the last read-only gap in the document diagnosis chain and add the first
low-stakes knowledge-base remediation acts: inspect exactly how an existing
document was chunked, reprocess one document or one source's existing
documents, and recrawl one already-configured website source. Record the
agent-scoped retrieval-probe decision without exposing a misleading tool.

### Knowledge, Ports, And Dependency Direction

- `operatorCopilot/tools/documents.ts` knows the model-facing schemas,
  chunk-index page limit, safe output projection, tool shape, and permission.
  It must not know SQL, document queues, crawl configuration parsing, or HTTP
  route details.
- A copilot-owned chunk inspection port exposes only the existing
  workspace-scoped summary/detail reads needed to assemble a page. A copilot
  action port exposes only document/source reprocess and stored-source recrawl.
  These are consumer-shaped ports, not borrowed Documents service types.
- Documents remains the owner of source validation and stored crawl settings.
  A focused source-recrawl service resolves the source, enforces website-only
  recrawl, bounds the persisted crawl limit, and delegates enqueueing to the
  existing crawl job service. REST and Ray call the same application service.
- `app/composition/copilotToolCatalog.ts` and server assembly bind the narrow
  ports to the existing chunk repository, ingestion/source-reprocess services,
  and the Documents-owned recrawl service. Composition owns wiring only.
- Retrieval remains the owner of effective retrieval settings. This slice
  records optional agent scoping as the target public-contract design and keeps
  the workspace-default retrieval operations excluded until that separate API
  and SDK change ships.

Dependency direction is `operatorCopilot descriptor -> consumer port ->
Documents application primitive/repository port`; Documents never imports Ray,
and composition is the only layer that sees both sides.

### Payload And Safety Decisions

- `document_chunks` uses an inclusive starting chunk index plus a strict page
  limit. It fetches full detail only for that selected page and never runs the
  result through `payloadCompaction`, because chunk text is the requested
  evidence. The response states totals, returned indexes, unavailable chunks,
  and the next index explicitly.
- `reprocess_document` is one family act that accepts exactly one of a document
  id or source id; source scope means existing documents belonging to that
  source, never a whole workspace. `recrawl_source` accepts only a persisted
  source id and never a caller-supplied URL.
- All reads and acts remain workspace-scoped and receive the same current-
  authorization rechecks as every catalog descriptor. Reads require
  `workspace.documents.read`; acts require `workspace.documents.manage`.

### Constitution And Impact Check

- This is an approved amendment to spec 104 (D8/D9, FR-020..FR-022). Backend
  work follows red-green TDD with focused tool and source-recrawl tests written
  before implementation.
- No new storage, provider, secret, setting, HTTP route, OpenAPI schema, SDK,
  MCP, connector, or worker payload is introduced. Existing public operations
  are re-used, so the TypeScript SDK snapshot does not change.
- Message-queue impact: document/source reprocessing and recrawl retain their
  existing durable job records, dispatch payloads, retry semantics, and worker
  consumers. No AMQP payload, queue contract test, or queue documentation
  change is required.
- Composition changes are assembly-only. Source validation moves out of the
  HTTP route into Documents; no product rule moves into composition or Ray.
- Observability: document/source reprocess retains existing audit and status
  invalidation, recrawl retains its durable job record, crawl invalidation, and
  dispatch-failure logging, and Ray already emits generic per-tool activity and
  failure telemetry. No new log/metric/span is needed; raw chunk text and
  metadata must never enter logs or audit metadata.
- Operator documentation changes to describe chunk inspection and maintenance
  acts. Settings docs do not change because no setting changes.

### Delivery Slices

1. Add failing unit tests for full-text range paging, workspace-scoped port
   calls, action classification/permissions, document/source action dispatch,
   and stored-source recrawl validation.
2. Add the Documents-owned source-recrawl service and make the existing REST
   route delegate to it without changing the public contract.
3. Add the three document-family descriptors, consumer ports, production/test
   wiring, capability provenance, owning primitive, and coverage-map moves.
4. Update Ray operator documentation and the behavior-eval fixture, run focused
   tests/build/architecture checks, complete review passes, then record #1051's
   decision and refresh the epic state.
