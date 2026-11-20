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
  `RoutineDraftAssistService` with the same language. Its ports can list names
  and draft; none can write.
- **Apply** (`applyService.ts`) writes exactly the selected items through the
  owning services, `AuthoredDirectiveService.create` and
  `RoutineDefinitionService.createDraft`. It never touches their tables
  directly, and it never updates or deletes an existing item.

Directive coherence (an advisory model check, returned per directive) runs
before the transaction, through `AuthoredDirectiveService.assessCoherence`, so
no model call happens while the agent's lock is held. The assessment returns a
token over every input the model read. Inside the transaction, apply recomputes
that token under the lock; if the agent changed in between, it writes nothing,
reassesses, and gives up with `409 starter_pack_agent_changed` after three
assessments. A completed request is replayed before any model call, and checked
again under the lock.

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
workspace summary's `llmConfigured` use.

## Public Surfaces

- `public.ts`: request schemas, the draft and apply services, the generator,
  and the rate-limit policies.
- `backend/src/app/http/routes/agentRoutes.ts`: `POST /api/v1/agents/:agentId/starter-pack/draft` and `/apply`.

## Tests

- `cd backend && pnpm exec vitest run tests/unit/agentStarterPack tests/unit/agent-starter-pack-draft-route.test.ts tests/unit/agent-starter-pack-apply-route.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/eval-suite/starter-pack-draft-quality.test.ts` (deterministic draft-quality eval)
- `cd backend && pnpm exec vitest run tests/contract/agent-starter-pack.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/agent-starter-pack-apply.integration.test.ts` (needs `INTEGRATION_DATABASE_URL`; covers rollback and concurrency)
