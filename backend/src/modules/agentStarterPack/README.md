# Agent Starter Pack Module

The starter pack gives a new agent a first set of behavior from one sentence
about its purpose: up to six directives and exactly one routine, drafted by the
model, reviewed by the operator, and applied as a unit. Start here when a feature
changes how a purpose becomes suggestions, or how reviewed suggestions are
written to an agent.

For the broader repository map, see
[`docs/architecture/code-map.md`](../../../../docs/architecture/code-map.md).
The API is documented in `docs-portal/content/api/agents-and-skills.mdx`.

## Boundaries

Drafting and applying are separate operations with separate ports.

- **Draft** (`draftService.ts`) reads only. It detects the purpose's language,
  renders `backend/prompts/agent-setup/starter-pack-draft.md` with that language
  in `{{output_language_instruction}}`, and hands the routine's procedure to
  `RoutineDraftAssistService` with the same language and the pack's routine
  name, which the drafter validates under. The procedure marks each value the
  routine collects with an `@key`, the drafter's variable hint, so each becomes
  a slot its steps reference. Its ports can list names and draft; none can write.
- **Apply** (`applyService.ts`) writes exactly the selected items through the
  owning services, `AuthoredDirectiveService.create` and
  `RoutineDefinitionService.createDraft`. It never touches their tables
  directly, and it never updates or deletes an existing item.

Apply checks everything cheap before any model call: it reads the agent's
directive and routine names (a taken name is a `409 starter_pack_name_conflict`)
and checks that each directive's `excludes` names a directive already on the
agent, a built-in one, or a pack directive listed before it (otherwise `400`).
A completed request with the same key is replayed instead. The transaction
repeats all of these under the agent's lock.

Directive coherence (an advisory model check, returned per directive) runs
before the transaction, through `AuthoredDirectiveService.assessCoherence`,
which checks the candidates concurrently, so no model call happens while the
agent's lock is held. The assessment returns a token over every input the
model read. Inside the transaction, apply recomputes that token under the lock;
if the agent changed in between, the verdicts are stale, and the directives are
saved with the "Coherence check unavailable" verdict instead. Coherence never
blocks an apply. The created routine is returned with its validation result,
in the shape the routine authoring endpoints return it.

This module knows nothing about Postgres or Express. Apply runs through the
`StarterPackApplyUnitOfWork` port; `app/composition/agentStarterPackComposition.ts`
implements it as one transaction that takes the agent's draft lock first, binds
the directive and routine services to that transaction, and writes the
idempotency record (`agent_starter_pack_applies`) in it. That gives three
guarantees: all or nothing, one result per idempotency key, and no duplicate
names under concurrent requests. Applied items land in the agent draft;
publishing goes through the agent revision flow in `../agents/`.

Whether the workspace can call a chat model comes from
`shared/infra/llm/chatReadiness.ts`, the same check Ray's availability and the
workspace summary's `llmConfigured` use. It asks `LlmProviderRegistry` whether
the chat inference pipeline, which drafting and Ray run on, resolves for the
workspace: the deployment's chat provider and model with a readable key for
that provider, exactly as a call resolves it. Only a provider configuration
error means "not configured"; a missing key's 503 names the provider.

Both endpoints spend their rate limit through a `beforeModelCalls` hook the
services run just before their first model call, so a 404, a missing chat
model, a replayed apply, or a refused pack spends nothing. A request aborted by
its client stops its model calls and is logged as aborted.

The draft parses the model's answer one directive at a time: unknown keys are
ignored, and a directive the authored-directive contract would refuse, or a
repeated one, is dropped (counted in the `starter_pack_draft_llm_call_completed`
log and telemetry). The draft fails with `422 invalid_starter_pack_draft` when
the routine is invalid, no directive is left, or the routine drafter could not
produce a routine.

## Public Surfaces

- `public.ts`: request schemas, the draft and apply services, the generator,
  and the rate-limit policies.
- `backend/src/app/http/routes/agentRoutes.ts`: `POST /api/v1/agents/:agentId/starter-pack/draft` and `/apply`.
- `backend/src/app/server/builders/agentStarterPack.ts`: builds both services from the routine authoring services.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/agentStarterPack tests/unit/agent-starter-pack-draft-route.test.ts tests/unit/agent-starter-pack-apply-route.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/eval-suite/starter-pack-draft-quality.test.ts` (deterministic draft-quality eval)
- `cd backend && pnpm exec vitest run tests/contract/agent-starter-pack.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/agent-starter-pack-apply.integration.test.ts` (needs `INTEGRATION_DATABASE_URL`; covers rollback and concurrency)
