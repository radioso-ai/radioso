# Implementation Plan: Agent Draft Publishing

**Branch**: `audit-agent-versioning` | **Spec**: `specs/1149-agent-draft-publishing/spec.md`

## Technical Context

Node.js/TypeScript backend, PostgreSQL, Express/Zod/OpenAPI, React/Next.js frontend, existing conversation engine, routine runtime, and eval runner. PostgreSQL is the system of record. No new provider, queue, or prompt asset is introduced.

## Constitution Check

| Principle | Plan response |
| --- | --- |
| Spec-first | Approved spec precedes production changes. |
| Backend TDD | Every backend slice starts red with focused unit/integration/contract tests before implementation. |
| Stack | Uses existing Node, React, PostgreSQL, and existing engines. |
| Secrets | No new secrets/configuration. |
| Modularity | `agents` owns draft/revision/publication; directive/routine/context modules expose narrow projection/validation ports; chat/eval consume resolver ports; composition wires adapters only. |
| Data/reliability | Transactional publication, authorization, idempotency, no live fallback, safe-test policy, content-safe audit/telemetry. |
| API/Docs | Code-first OpenAPI, generated artifacts, TypeScript SDK sync, contract/queue review, and operator/API docs are required. |
| Frontend tests | Playwright covers behavior; unit tests only cover nonvisual routing/state/API adapters. |

## Architecture and Boundaries

```text
writers (HTTP / Ray / SDK / MCP / dashboard / import / routines)
                       │ authorized draft commands
                       ▼
agents revision domain ── projection/validation ports ── directives/routines/context
       │ draft + revisions + publication                    
       ├── revision resolver port ─────► chat runtime / conversation bindings
       └── candidate provenance port ──► eval runs / test chat
                       │
             composition wires repositories and runtime readers
```

`agents` knows the aggregate, immutable revision shape, candidate assembly, concurrency, and publication invariants. It must not know HTTP, dashboard state, eval scoring, concrete DB, or provider wiring. Resource modules retain their own validation and executable projection rules. Chat receives resolved configuration plus revision identity and must never query mutable authoring state. Eval owns cases and outcomes; it consumes a narrow candidate/provenance reader. Composition only instantiates/wires ports.

## Delivery Phases

1. **Discovery seam and persistence**: map every scoped writer/runtime reader; introduce migrations and repository/domain ports for drafts, revisions, publication, bindings, and backfill classification. Add a migration/deployment barrier before cutover.
2. **Draft/candidate/publish domain**: TDD the aggregate, full coherent projection, validation, concurrency, idempotency, audit, and writer routing. Add public API/SDK/MCP/Ray contracts with explicit draft versus publish semantics.
3. **Revision-aware runtime**: bind production conversations at first turn, retain on resume/handoff/routine state, resolve candidate test conversations, and fail closed for unavailable revision/routine closure/context definitions. Wire composition.
4. **Eval provenance**: freeze selected revision/cases/inputs/policy before dispatch, preserve queue identity across retry, and expose partial comparison behavior without a publish gate.
5. **Lifecycle/backfill**: existing agents become live equivalent revisions; legacy conversations/routines are classified; new/imported agents stay unpublished; old workers are drained/blocked before revision-bound dispatch.
6. **Cockpit and docs**: frontend consumes the explicit backend contract, moves navigation, implements test/compare/eval UI and focused Playwright coverage; update operator/API/SDK/MCP docs.

## Data and Transaction Design

- Persist agent draft metadata/content, immutable revision payload/version, publication records and current pointer, conversation/relevant routine bindings, eval-run provenance, and migration classifications.
- Assemble and validate a revision from a consistent scoped graph. Prefer one draft aggregate/generation boundary; do not add independent draft flags across unrelated resource tables.
- Publish in a short transaction checking authorization, agent/workspace ownership, draft generation, published pointer, idempotency, routine/context/reference integrity, then append audit and move pointer. Provider calls and evals remain outside it.
- Retain immutable routine definitions/closure needed for a bound revision and active routine state. A candidate may not discover later routines by agent ID.

## Contracts and Queue Impact

- HTTP changes are code-first in `backend/src/app/http/openapi/document.ts`; generate `backend/openapi.yaml`/`.json` and run `cd typescript-sdk && pnpm run sync` in the same change.
- REST, SDK, MCP, Ray, dashboard and routine endpoints that currently directly write scoped configuration change to draft commands. Publish is an explicit authorized, idempotent command. This is a deliberate compatibility change and requires versioned/migration guidance.
- Revision-bearing conversations/evals and any queue payloads are cross-service contracts. Review document worker dispatch: it is not expected to own agent execution, but its payloads/tests/docs must be checked and explicitly recorded. Eval worker/job payloads must include frozen revision/case/input/policy identities, support idempotent retry, and never re-resolve latest draft.
- No runtime prompt asset change is planned; `backend/prompts/` is therefore unaffected.

### Actual writer/reader inventory and queue decision

The implementation inventory is recorded in `.context/agent-versioning-writer-reader-inventory.md`.
The scoped writers are the agent HTTP PUT/create paths, authored-directive routes and service,
routine lifecycle service, context-variable enablement paths, bundle import/wizard, Copilot
proposal adapters, MCP proposal application, and the dashboard adapters. Test-only config
overrides in eval/workbench are excluded from production authoring. The runtime readers are
`chatSessionPreparer`, `routineDefinitionSource`, context-variable resolution, the revision-aware
test/eval readers, and the pinned conversation/routine-state paths. The implementation owners are
the modules named by those paths; composition wires their ports in
`backend/src/app/server/dependencies.ts` and the server builders.

Queue review is complete. Document ingestion remains on the existing durable-first dispatch
contract owned by `backend/src/modules/documents/services/documentIngestionService.ts`,
`documentProcessingService.ts`, and `backend/src/modules/documents/services/documentJobDispatcher.ts`;
the Cloud Tasks and AMQP adapters carry document job ids/trace metadata and do not carry agent
revision state. Revision evals use `RevisionEvalRunService` and
`backend/src/db/repositories/revisionEvalRunRepository.ts`: the run/case rows, serialized run
lock, lease fence, frozen revision/case/input/policy identities, and explicit retry are the durable
dispatcher. There is no new AMQP/Cloud Tasks payload or document-worker consumer to migrate. The
queue compatibility decision is therefore: no document queue change; preserve existing document
payload/retry semantics; validate revision-eval lease idempotency and retry in its repository and
integration tests.

The actual boundary is `agents` for draft/revision/publication identity and invariants;
directives, routines, and context variables own their projections and validation; chat consumes
resolved immutable revision data; eval consumes frozen candidate/provenance data; composition owns
adapter wiring. Observability is content-safe audit/log correlation for draft save, publication,
revision resolution failures, test/eval attempts, retries, and migration classification using
workspace/agent/revision/run identifiers and bounded outcome categories. Prompts, completions,
chunks, sample values, credentials, cookies, and connection strings are excluded. Copilot/MCP
coverage and their explicit revision/test/eval exclusions live in
`backend/tests/unit/operatorCopilot/catalogCoverage.ts` and
`backend/src/modules/operatorCopilot/operatorMcpDisposition.ts`. Authoring/test/eval MCP exposure
is excluded where the transport cannot yet carry the approved draft/revision semantics; no new
tools are added.

Compatibility is a deliberate migration: existing agents receive a live-equivalent published
baseline and a matching editable draft, while saved unpublished routine work is preserved
separately and remains private. New and imported agents remain unpublished until first publish.
Ongoing conversations retain their bound revision and there is one published pointer shared by all
channels, not a per-channel revision. Migration 171 requires an old-traffic/old-worker drain
barrier before revision-bound readers or writers serve traffic. Legacy active routine-state
retention preserves the exact safely identified closure in the immutable baseline. Missing,
ambiguous, or invalid pins are recorded for operator follow-up and leave their conversations
unbound so revision-aware runtime resolution fails closed.

## Observability, Security, and Rollout

- Add audit and bounded telemetry/log correlation for draft save, candidate creation, publish, revision resolution failure, test/eval execution, partial/retry and migration classification. Exclude contents, samples, prompts, completions, chunks, credentials, cookies, and connection strings.
- Candidate IDs are operator-only; public channels cannot choose drafts. Test execution must use existing safe-test dispatch or fail closed. Preserve live authorization/credential/disable controls even for pinned conversations.
- Stage schema/backfill/equivalence validation, deployment barrier and old-worker drain, reader cutover, writer cutover, then first-publish flow. Do not map unsafe legacy routine state/conversations by guesswork.
- For the 171 cutover, first stop admission to old application replicas and stop old worker consumers; wait for their in-flight requests and claimed jobs to drain, then verify no old replica remains. Apply the migration and validate baseline pointers/conversation bindings while authoring remains unavailable. Start only revision-aware application and worker replicas after that validation. Do not enable new draft writers while any live-authoring reader or writer from the old release can still serve traffic or consume work.

## Validation Plan

- Unit/domain: snapshot completeness, invalid/missing refs, context compatibility, stale tokens, idempotency, routine closure, resolver no-fallback, conversation pinning, eval provenance/freshness.
- Integration/contract: all writers route to draft, publish transaction/audit, migration/backfill classification, production/test authorization, OpenAPI/SDK/MCP contracts, queue retry/idempotency.
- E2E: scoped edit → save → private test/compare → eval → publish; tab/deep-link/unsaved behavior; stale stream and partial comparison; new/imported first publish.
- Regression: deterministic conversation-quality and copilot eval suites plus focused routine/chat/eval tests. Live eval suites remain on-demand.

## Material Risks Requiring Resolution During Discovery

1. Current APIs and routine lifecycle endpoints publish/directly mutate live behavior. They cannot remain semantically identical while satisfying private drafts; each caller must be migrated or explicitly rejected.
2. Existing routine preview/version retention and chat session preparation must prove they can resolve a complete revision closure. If they only resolve latest agent rows, a boundary extraction is prerequisite work.
3. A deployment with old writers/readers and new revision-bound jobs is unsafe. The cutover requires a validated barrier/drain plan before writer enablement.


## Approved cockpit usability follow-up

The sidebar owns agent identity, selection, creation, and channel navigation. It reads the existing channel catalog and configuration to list enabled channels, retains attention states for disconnected channels, and routes Manage channels to an overview. The cockpit header owns compact draft/publication controls; channel settings do not participate in that lifecycle.

The agents domain owns stable release numbering. Persistence allocates the next per-agent number under the existing publication lock, and idempotency returns the original number. A new migration after 177 deterministically backfills published revisions. Transport summaries expose version numbers and the draft's published base; frontend labels never derive release numbers from generations or array positions.

The test-execution domain owns private durable execution listing and detail. Its narrow agent revision read port supplies immutable provenance. Existing message/retry ports resume an execution with original fences, histories, samples, and safe-test policy. Legacy test history remains in its existing owner and is presented alongside new executions with an explicit legacy label. Proactive private start reuses the `chat.bootstrap` audit and analytics metadata path and emits `agent.test_execution.started`; it requires no new queue or document-worker payload, retry, or dispatcher contract. Existing PostgreSQL execution persistence and retry semantics remain authoritative. Read-only history adds no new provider path or noisy content logging. Publication and execution retain existing content-safe audit and diagnostic correlation.

Frontend API adapters own transport types; Test Chat owns proactive greeting startup when enabled, lazy first-send when disabled, history adoption, and execution state. The authoring owner exposes a narrow asynchronous private-save port to Test Chat. Save draft & send awaits actual persistence and refreshed candidate identity; a rejected save cannot dispatch a provider. New chat must not cancel eval polling for unchanged inputs and starts a fresh greeting only when the setting is enabled. Shell and editor ownership remain separate from backend revision rules.

Validation covers concurrent/idempotent number allocation and stable backfill, private history permissions and exact detail, first-send single/compare, durable reopening and legacy access, save failure preventing execution, sidebar/channel navigation and creation permissions, and preserved retry/eval fences. Public contract changes regenerate OpenAPI and SDK snapshots and carry explicit copilot coverage exclusions.

The two private history read operations are explicitly deferred in the Copilot coverage map alongside the existing private test execution family. The documented exclusion ratchet moves from 102 to 104 for these approved operations; current descriptors cannot present immutable test samples and attempt provenance.
