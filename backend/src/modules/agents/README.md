# Agents Module

Agents own the mutable authoring draft and the immutable revision aggregate:
candidate snapshots, publication history, the current published pointer, and
the draft generation used for optimistic publication checks.

Start here for revision state, candidate materialization, publication, or the
backfill rule for existing and newly created/imported agents. The HTTP entry
points are `app/http/routes/agentRevisionRoutes.ts`; persistence is in
`db/repositories/agentRevisionRepository.ts`; runtime resolution is under
`agents/runtime/`.

The agents module owns revision selection and fail-closed production resolution.
Private Test Chat and revision evals consume its narrow ports; they never read
the mutable draft directly. `AgentRevisionService.resolveDefaultTestRevision`
decides which revision a test runs when the operator names none. Writer modules continue to own their resource
validation and use the shared draft-mutation boundary.

Agents also store and serve the `voice` settings block (`voiceSettings.ts`):
its schema, the voice-off default, and a tolerant reader for stored blocks. It
lives in `behavior_settings.voice`, travels on `GET`/`PUT /api/v1/agents/:agentId`,
and stays out of `agentInputFieldSchemas`, so Ray's `propose_agent_setting`
cannot reach it. The voice channel reads it through type-only imports from
`public.ts`; nothing here loads the voice runtime.

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/agent-revision-service.test.ts tests/unit/agent-revision-routes.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/agent-revision-runtime-resolver.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/agent-voice-settings.test.ts tests/contract/agent-voice-settings.contract.test.ts`
