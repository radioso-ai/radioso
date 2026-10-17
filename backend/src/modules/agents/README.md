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
its schema, the voice-off default, and a tolerant reader for stored blocks (a
stored block without `runtime` reads as bound to no vendor agent). `runtime`
names the vendor agent a voice session start opens, by a vendor from
`shared/domain/voiceVendor.ts`; the vendor's key is a workspace credential,
not part of the block. It
lives in `behavior_settings.voice` and travels on `GET`/`PUT /api/v1/agents/:agentId`,
which the dashboard's Voice card (`frontend/components/dashboard/settings/voice-channel-card.tsx`)
writes. It has an `agentInputFieldSchemas` entry and a place in the reviewed patch, so Ray
authors it with `propose_agent_setting` or `prepare_agent_settings`, replacing the block
whole; it is outside the portable config, so `agent_configuration` returns it beside it.
The voice channel reads it through type-only imports from `public.ts`; nothing here loads
the voice runtime.

Agents also store and serve the `mechanicsReplies` block (`mechanicsReplies.ts`): the
lines an agent says, word for word, to a greeting, thanks, farewell, or
acknowledgement, keyed by language tag. It lives in `behavior_settings.mechanicsReplies`,
travels on `GET`/`PUT /api/v1/agents/:agentId` (an update replaces the block whole; a
body that leaves it out leaves the stored one alone), and is a portable field of the
agent config, so Test Chat, eval replay, and bundle import speak the same lines as live
chat. The Voice card edits it beside the `voice` block, and Ray authors it the same way,
reading it through `agent_configuration`. The chat module's quick-reply lane reads it
(`modules/chat/services/quickReplyWording.ts`).

Focused checks:

- `cd backend && pnpm exec vitest run tests/unit/agent-revision-service.test.ts tests/unit/agent-revision-routes.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/agent-revision-runtime-resolver.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/agent-voice-settings.test.ts tests/contract/agent-voice-settings.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/unit/agent-settings-proposal-owner.test.ts` (Ray's proposals for both blocks)
- `cd backend && pnpm exec vitest run tests/unit/agent-mechanics-replies.test.ts`
