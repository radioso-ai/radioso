# Implementation Plan: Agent-consumable service surface — slice 1 (US1 + US2)

**Spec**: `specs/1290-agent-consumable-service-surface/spec.md` (FR-001..FR-005, FR-010..FR-017; SC-002, SC-004)
**Issue**: #1290
**Out of scope here**: US3–US7 (cards, walk-in, resumption, `callerKind`, snippets). Hooks for them are marked *(hook)*.

## What the code says today (verified; corrects the spec where they differ)

- `AgentConverseService.askAgent` (`backend/src/modules/chat/services/agentConverseService.ts:36-99`) always calls
  `assistantChatService.answer` with `stream: false`; the MCP `ask` schema is `stream: z.literal(false)` — the MCP
  route has no streaming path. FR-004's terminal frame applies to `POST /agents/:id/chat` SSE (`sendChatSse` `done`
  event, `chatPresenter.ts:150-176`) and, for free, to `/assistant/chat`.
- `ChatResponse` (`chat/types/chatResponses.ts:46-70`) already carries `ownership?`, `answerCoverage?`, `citations?`
  (`ChatCitation { documentId, chunkId, title, sourceUrl? }`), `turnTrace?.traceId`. `presentChatPayload` moves
  `answerCoverage` under `debug` and drops it for the REST audience; `ownership` passes through only when set.
  Nothing on `ChatResponse` or the engine's `ProcessTurnResult` describes routine status or pending slots; the
  lifecycle (`chatTurnLifecycle.ts:810-830`) does hold `routineStateTransition` (`{kind:"save", state}|{kind:"clear"}`),
  `pendingDecisionTransition`, `suspended`, `ownershipHandoff` when it builds the response.
- `conversationId` returned by MCP `ask` is `principal.publicSessionId`, not the conversation row id. Keep that.
- `ConversationRoutineActivator.activate` (`packages/conversation-contract/index.d.ts:1340-1355`) already returns
  `{ kind: "activate", routineId, variables? }`, and `routineActivation.ts:305-312` seeds a fresh `RoutineState` with
  `variables: activation.variables ?? {}`. Direct admission with prefilled slots needs **no engine or contract change**.
  The activator is consulted only when no routine is active (`routineActivation.ts:179-215`); an active routine resumes
  through the normal path, and completed ones go through `reentryGate` first — so AS-5/AS-6 hold by construction.
- Compiled `Routine.slots` already carries `required` and `description` (`index.d.ts:1007-1015`); `Routine.metadata`
  carries `definitionId`, `name`, `version` (`routines/compiler.ts:250-256`) but not `lineageId` or exposure.
- `routine_definition` is normalized columns, not JSONB (migrations 084, 090). `exposure` needs a migration. Agent
  revision snapshots (`agents/agentRevision.ts:32-34`) re-parse `routineDefinitionSchema` (strip mode), so the
  exposure block rides into published snapshots once it is on the schema. Publish-time validation is
  `assertCandidateSnapshotIsRunnable` (`agentRevision.ts:127+`), called from `agentRevisionRepository.createCandidate/publish`
  inside the transaction, where `agent.published_revision_id` is in scope but the previous snapshot is not loaded.
- The MCP package's `src/generated/openapiTypes.ts` is **not consumed** by any runtime code; `converseApiAdapter.ts`
  is hand-typed. `sessionServerManager.ts:37` keys the server cache by the constant `"ask_agent"` — there is one
  shared `McpServer`, not one per session. `AccessSessionRecord` has no agent id. `toCallToolResult` already forwards
  `data` as `structuredContent`.
- `UserMessageInputMetadata.method` is validated on read (`messageRepository.ts:119-145`): an unknown `method`
  drops the whole metadata object. A new method value must be added there or Activity never sees it.
- Ray routine proposals share `target_type = 'routine'` (migration 143) and ride `routineFieldPatchSchema` ops
  (`routines/authoringEdit.ts:32-64`) through `propose_routine_edit`. No new target type is needed.
- Eval harness (`backend/src/modules/eval/suite/caseSchema.ts`, `traceAssertions.ts`) drives `WorkbenchReplayRunner`
  with `query` + optional `routineStartState`; assertions `routine_step_reached` and `turn_uses_skill` exist; no
  negative skill assertion, no fixture routine with a skill step.

## Design answers (the three questions)

**What does each part know?**

- `packages/routine-definition`: the `exposure` schema (`{ enabled, toolName, description }`), the tool-name
  pattern, the new validation codes. Not: reserved names, JSON Schema, MCP, publish history.
- `backend/src/modules/routines/exposure/` (new): reserved names; descriptor derivation (slot → JSON Schema);
  invocation validation; cross-routine exposure rules (duplicate, frozen name, gated activation); rendering an
  invocation as the recorded message text; the direct-invocation activator. Not: HTTP, which transport asked,
  `ChatResponse`, turn reporting.
- `backend/src/modules/routines/routineTurnReporter.ts` (new, sibling of `exposure/`): status + pending slots
  from a compiled routine and its `RoutineState`, for *any* admitted routine — exposure is irrelevant to it.
- `backend/src/modules/chat`: the agent turn input (`message` | `routine`), resolved and validated **once** before a
  turn through `resolveAgentTurnInput`; the reply envelope built from `ChatResponse` by a pure function; threading
  `routineInvocation` from request → session → routine provider. Not: slot types, exposure rules, MCP.
- `backend/src/modules/agents` (`agentRevision.ts`): that publish runs the routines module's exposure rules against
  the previously published snapshot. Not: what the rules are.
- HTTP routes / OpenAPI: request/response schemas; they call the chat module's resolver and envelope. They validate
  nothing about routines themselves.
- `packages/radioso-mcp-server`: fetches the catalog per session, renders descriptors as tools, forwards the
  envelope. Not: routines, slots, coverage. Consumes the generated OpenAPI types (this plan makes that true).

**What ports, to whom?** (each exact TS shape lives at the named file)

- `AgentToolDescriptor` — `backend/src/modules/routines/exposure/agentToolDescriptor.ts`
  `{ toolName: string; description: string; inputSchema: JsonSchemaObject; routineLineageId: string }` where
  `JsonSchemaObject = { type: "object"; properties: Record<string, { type: "string"|"number"|"boolean"; format?: "email"|"date"; description?: string }>; required: string[]; additionalProperties: false }`.
  Published in OpenAPI as `AgentToolDescriptor`. Consumers: catalog route, `resolveAgentTurnInput`, MCP package *(hook: cards, `ask_agent` description formatter)*.
- `AgentToolCatalogPort` — `backend/src/modules/routines/exposure/agentToolCatalog.ts`
  `{ load(input: { workspaceId: string; agentId: string; agentRevisionId?: string }): Promise<{ agent: { name: string; description: string | null }; tools: AgentToolDescriptor[] }> }`
  built over a narrow `PublishedRoutineReader { listPublished(input): Promise<RoutineDefinition[]> }` that composition
  implements from `agentRepository` + `agentRevisionRepository` (mirrors `routineDefinitionSource.ts`).
- `RoutineInvocation` — `backend/src/modules/chat/contracts/routineInvocation.ts`
  `{ toolName: string; routineLineageId: string; input: Record<string, string | number | boolean> }` (post-validation, typed by the descriptor).
  `validateRoutineInvocation(descriptor, input): { ok: true; input } | { ok: false; errors: Array<{ path: string; code: "required"|"type"|"format"|"unknown_field" }> }`
  lives in `exposure/routineInvocationValidator.ts` (routines module); the chat module calls it.
- `ChatRoutineProvider.forTurn` input gains `routineInvocation?: RoutineInvocation`; result gains
  `reporter?: ChatRoutineTurnReporter` — `backend/src/modules/chat/contracts/routineProvider.ts` (extracted from
  `chatTurnAssembly.ts:207-235`). `ChatRoutineTurnReporter { describe(input: { state: RoutineState; awaitingDecision?: boolean; handedOff?: boolean }): ChatRoutineTurnState | null }`.
- `ChatRoutineTurnState` — `chat/contracts/routineTurnState.ts`
  `{ toolName?: string; name: string; status: "active"|"waiting_for_input"|"waiting_for_approval"|"completed"|"abandoned"; pendingInput: Array<{ key: string; type: RoutineSlotType; required: boolean; description?: string }> }`.
  Added as `routine?` on `ChatResponse` and on the `done` stream event.
- `AgentReplyEnvelope` — `chat/services/agentReplyEnvelope.ts`, `buildAgentReplyEnvelope(response: AgentReplyEnvelopeSource): AgentReplyEnvelopeCore`
  where `AgentReplyEnvelopeCore = { conversationId: string; answerCoverage: ChatAnswerCoverageAssessment; ownership: ChatOwnershipAck; routine?: ChatRoutineTurnState; traceId?: string }`
  and `AgentReplyEnvelopeSource = Pick<ChatResponse, "conversationId"|"answerCoverage"|"ownership"|"routine"|"turnTrace">` (satisfied by both `ChatResponse` and the `done` event).
  MCP response = core + `answer: { text, citations: ChatCitation[] }`; REST response = existing payload + core (FR-002).
- `AgentTurnInput` — `chat/services/agentTurnInput.ts`, `resolveAgentTurnInput(catalog, { workspaceId, agentId, agentRevisionId?, body: { message?: string; routine?: { toolName: string; input: unknown } } }): Promise<{ kind: "message"; message: string } | { kind: "routine_invocation"; invocation: RoutineInvocation; descriptor: AgentToolDescriptor }>`.
  Throws `badRequest` with `code: "routine_invocation_invalid"` + `details.errors` or `notFound` with `code: "routine_tool_unknown"`. Called by both routes before any turn state is written (FR-014).

**Dependency direction.** `routine-definition` ← `routines/exposure` ← `chat` ← routes/OpenAPI ← MCP package (via
generated types only). `agents` depends on `routines` (already does). `conversation-engine` is untouched.
Composition (`backend/src/app/composition/`) wires the catalog's published reader and passes the catalog into the
converse module and the REST route; product rules stay in `routines/exposure`.

**The direct-invocation seam and why it sits there.** The seam is the routine turn provider
(`backend/src/modules/routines/turnProvider.ts`): when `forTurn` receives `routineInvocation`, it substitutes the
prefilter + `RoutineRegistry` ranked match with `createDirectInvocationActivator(registrations, invocation)`, which
resolves the tool name against the turn's *effective registrations* (compiled `Routine.metadata.exposure.toolName`,
so it sees exactly the pinned revision's routines, including preview/pinned sets) and returns
`{ kind: "activate", routineId, variables: invocation.input, decisionMetadata: { decision: "direct_invocation", ... } }`,
honouring `suppressedRoutineIds` (a `once_per_conversation` routine already completed returns `null`, so the turn
falls through to the normal answer — reentry governs, AS-5). The coverage activator is omitted for that turn. The
engine, runner, reentry gate, interruption rules, approvals, and the outbox see an ordinary activation with initial
variables; `isSatisfiedSlotCollectionStep` (`routineRunner.ts:261-270`) fast-forwards filled collection steps. This is
the one place that already owns "which routines are eligible and how one gets admitted"; putting it anywhere higher
would teach the chat module routine identity, and anywhere lower would change the engine contract for no gain.

## Slices (sequential; each compiles, passes its tests, and passes root `pnpm run lint` + `lint:dead-code:ci`)

### Slice 1 — Reply envelope on both routes (US1, FR-001..FR-005)

Extraction-only commit first (no behaviour change): move `ChatRoutineProvider` out of `chatTurnAssembly.ts`
(1504 lines) into `chat/contracts/routineProvider.ts`; move the `/:agentId/chat` handler out of `agentRoutes.ts`
(854 lines) into `backend/src/app/http/routes/agentChannelChatRoute.ts`; export `AgentConverseAskResult` from
`chat/contracts`. Then:

Files: `chat/contracts/routineTurnState.ts` (new), `chat/types/chatResponses.ts` (+`routine?`),
`chat/contracts/streamEvents.ts` (`done` +`routine?`), `chat/services/agentReplyEnvelope.ts` (new),
`chat/services/chatTurnLifecycle.ts` (populate `routine` via `reporter`; always populate `answerCoverage`, with
`{ availability: "not_recorded", originatingTurnId/RequestId: session.userMessage.id }` when no assessment exists),
`chat/services/chatService.ts` (only: pass `reporter` into the lifecycle input and onto the `done` event — no new
logic in this 1852-line file), `routines/routineTurnReporter.ts` (new; `describe` maps
`pendingDecision`/`suspended` → `waiting_for_approval`; `save`+`active` whose current step (`path.at(-1)`) is a chat
step with unfilled `collectsSlots` → `waiting_for_input` (those slots are `pendingInput`, from `Routine.slots`);
`save`+`active` otherwise → `active`; `completed`/`clear` after terminal → `completed`; `expired` → `abandoned`;
handoff terminal → `completed` with `ownership` telling the rest), `routines/turnProvider.ts` (return `reporter`),
`agentConverseService.ts` (return `{ conversationId: publicSessionId, answer: { text, citations }, ...buildAgentReplyEnvelope(response) }`),
`agentChannelChatRoute.ts` (JSON: `{ ...presentChatPayload(response), ...buildAgentReplyEnvelope(response) }`;
SSE: `sendChatSse(res, events, { agentEnvelope: true })`), `chatPresenter.ts` (the option merges the envelope into
`done`), `mcpConverseSchemas.ts` (`mcpConverseAskResponseSchema` gains `answerCoverage`, `ownership`, `routine?`,
typed `citations`), `openapi/schemas/assistantHistorySchemas.ts` (`AssistantChatResponseSchema` gains the same core
fields; `RoutineTurnStateSchema` registered once and shared), `chat/README.md`.

Citations stay `ChatCitation` (`sourceUrl`, not `url`) on both routes — one shape, no rename (deviation from FR-001's
field name, noted for the spec author).

Tests first: `backend/tests/unit/chat/agentReplyEnvelope.test.ts` (defaults: no ownership → `ai_owned/false`;
no assessment → `not_recorded`; `traceId` from `turnTrace`); `backend/tests/unit/routines/routineTurnReporter.test.ts`
(each status branch; `pendingInput` carries `required`/`description`); `backend/tests/contract/agent-reply-envelope.contract.test.ts`
(both operations' response schemas declare the core; SC-004); `backend/tests/integration/agent-reply-envelope.integration.test.ts`
(grounded, out-of-scope verdict, human-owned suppressed, routine mid-collection, SSE `done` carries the envelope —
AS-1..AS-5). MCP package: `converseApiAdapter.ts` types `ConverseAskResponse`/exchange types as
`components["schemas"][...]` from `src/generated/openapiTypes.ts` (the file becomes load-bearing); `tests/converseTools.test.ts`
asserts `data` is the envelope and `summary === answer.text`.

Regenerate: `cd backend && pnpm run generate:openapi`; `cd typescript-sdk && pnpm run sync`;
`cd packages/radioso-mcp-server && pnpm run sync:openapi`. Docs: `docs/mcp-client-setup.md` (Converse calls: the
envelope), `docs/typescript-sdk-basic-usage.md` (agent chat response fields), `docs-portal/content/guides/mcp-server.mdx`
+ `pnpm --filter @radioso/product-docs run sync`. Observability: none new (no new runtime path); state that in the PR.

### Slice 2 — `exposure` on routine definitions: schema, validator, publish freeze, editor, Ray (FR-010, FR-011, FR-017)

Files: `packages/routine-definition/src/index.ts` (`routineExposureSchema = { enabled: boolean; toolName: string
(pattern `^[a-z][a-z0-9_]{1,62}$`); description: trimmed ≤ 500 }`, optional `exposure` on draft/update/definition
schemas; codes `exposure_tool_name_invalid`, `exposure_tool_name_reserved`, `exposure_tool_name_duplicate`,
`exposure_tool_name_changed`, `exposure_requires_ungated_activation`), `backend/src/db/migrations/186_routine_definition_exposure.sql`
(`exposure_enabled BOOLEAN NOT NULL DEFAULT false`, `exposure_tool_name TEXT`, `exposure_description TEXT`;
partial unique index `(agent_id, exposure_tool_name) WHERE status = 'draft' AND exposure_enabled` is **not** added —
uniqueness is a publish-time rule across the snapshot, see below), then `pnpm run db:types` **and** `pnpm run db:schema`
(both snapshots, committed together), `db/repositories/routineDefinitionRepository.ts` (map the three columns in the
row type, select, insert, update — no other change), `routines/exposure/reservedToolNames.ts` (`ask_agent`,
`get_conversation_updates` *(hook: US5)*), `routines/validator.ts` (per-definition: pattern, reserved,
`exposure.enabled && activation.gateRef` → `exposure_requires_ungated_activation`),
`routines/exposure/exposureSnapshotRules.ts` (`validateExposureAcrossSnapshot(routines, previouslyPublished?)`:
duplicate `toolName` among enabled exposures; `exposure_tool_name_changed` when the previous published snapshot's
routine of the same `lineageId` carries a `toolName` and the candidate's differs or is absent),
`agents/agentRevision.ts` (`assertCandidateSnapshotIsRunnable(snapshot, { agentDefaultLocale, publishedSnapshot? })`
calls it), `db/repositories/agentRevisionRepository.ts` (`createCandidate`/`publish` load `agent_revisions.snapshot`
for `published_revision_id` inside the transaction and pass it), `routines/authoringEdit.ts` (`set_exposure` op on
`routineFieldPatchSchema`; `describeRoutineFieldPatch` labels it), `routines/service.ts` (audit metadata gains
`exposureEnabled`, `exposureToolName`), `operatorCopilot/tools/routines.ts` (`propose_routine_exposure`: input
`{ routineId, enabled, toolName, description }` → `routine` target, payload `{ kind: "edit", changes: [{ op: "set_exposure", ... }] }`,
`targetLabel`/`summary` on the draft from the adapter — the card re-derives nothing), `backend/tests/unit/operatorCopilot/catalogCoverage.ts`
(no exclusion needed: the tool covers the control), frontend `lib/api-types.ts`, `lib/routine-document.ts`
(`updateExposure`), new `components/dashboard/settings/routine-exposure-editor.tsx` rendered from
`RoutineActivationEditor` in `routine-document-tab.tsx` (toggle "Expose as a tool", tool name, description;
diagnostics already render by message via `RoutineDiagnosticList`).

Tests first: `packages/routine-definition/tests/schema.test.ts` (pattern, optional block, update strips defaults);
`backend/tests/unit/routine-definition-domain.test.ts` (reserved, gated); `backend/tests/unit/routines/exposureSnapshotRules.test.ts`
(duplicate, frozen rename, first publish allowed, disabled exposure keeps its name); `backend/tests/integration/agent-revision-publish.integration.test.ts`
(publish refused with `exposure_tool_name_changed`; AS-8); `backend/tests/unit/routine-definition-service.test.ts`
(exposure persists through create/patch); `backend/tests/unit/operatorCopilot/copilot-catalog-coverage.test.ts`,
`copilot-eval-suite.test.ts` fixture case "let agents start returns directly" → `propose_routine_exposure` (AS-10);
`frontend/tests/unit/routine-document.test.ts` (`updateExposure` transform); Playwright
`frontend/tests/e2e/routine-document-editor.spec.ts` (enable exposure, invalid name shows the diagnostic, save).

Docs: `docs/authoring-routines.md` + `docs-portal/content/guides/authoring-routines.mdx` ("Expose a routine as a
tool"), product-docs sync, code map Routines section (`exposure/` folder). OpenAPI: routine bodies gain `exposure`
(additive) → regenerate + SDK sync. Observability: audit via `routine_definition.update` metadata (no values beyond
the operator-authored tool name); publish refusal is a validation error — see open decision 6.

### Slice 3 — Catalog route and routine invocation turn (FR-012..FR-016, SC-002)

Files: `routines/exposure/agentToolDescriptor.ts` (+ `inputSchema` builder; slot `text`→`string`, `number`,
`boolean`, `email`→`string/format=email`, `date`→`string/format=date`; `required` from the slot),
`routines/exposure/routineInvocationValidator.ts`, `routines/exposure/agentToolCatalog.ts`,
`routines/exposure/renderRoutineInvocation.ts` (`` `${toolName} ${JSON.stringify(input)}` `` — structural,
language-neutral, values verbatim; redaction is an operator-view concern, Decision 2),
`routines/exposure/directInvocationActivator.ts`, `routines/compiler.ts` (`metadata.lineageId`,
`metadata.exposure?: { toolName }`), `routines/turnProvider.ts` (branch on `routineInvocation`: substitute the activator, and make the
`reentryGate` and `slotCorrection` adapters unconditional no-ops for **every** completed state on that turn —
`routineActivation.ts:195-222` runs correction/reentry against `completedStates[0]` *before* consulting the
activator, so an unrelated completed routine would otherwise see the synthetic `toolName {json}` text through an
NL prompt and could hijack the turn. With both gates silenced, the direct-invocation activator alone decides:
matching routine completed under `once_per_conversation` → null + reported as completed (Decision 9); matching
routine completed under `always`/`semantic` → re-admitted with variables, no LLM call),
`app/composition/agentToolCatalog.ts` (new: published reader + catalog instance; injected into the MCP converse
module and the REST route), `chat/services/agentTurnInput.ts` (new), `chat/types/assistantApi.ts`
(`routineInvocation?: RoutineInvocation`; `message` optional when it is present), `assistantChatService.ts`
(accept either), `chatService.ts` / `chatSessionPreparer.ts` / `chatTurnAssembly.ts` (pass-through only, exactly as
`previewRoutineIds` is threaded: `chatSessionPreparer.ts:185,264,505`, `chatTurnAssembly.ts:221,471,683`,
`chatService.ts:287,1226,1274`; the preparer records the user message with `content = rendered text` and
`inputMetadata: { method: "routine_invocation", routine: { toolName, input: redacted } }`),
`db/repositories/messageRepository.ts` (`UserMessageInputMethod` + `routine?` on the type; `mapInputMetadata`
accepts the new method — the validation-on-read trap), `app/http/schemas/mcpConverseSchemas.ts` (`ask` body = object with optional `message` and `routine`
plus a refine requiring exactly one — not a bare `z.union`, which would silently match the first branch when both
keys are present; same refine shape as the REST schema; new `mcpConverseToolsResponseSchema`), `app/http/schemas/agentChannelSchemas.ts` (`routine?`; refine: exactly one of
`message` / `routine` / `startConversation`; `routine` + `stream` allowed), `app/http/routes/mcpConverseRoutes.ts`
(`GET /tools`: `rateLimitMcpSource`, `requireMcpConverseSession`, returns the catalog for the principal's agent;
`/ask` calls `resolveAgentTurnInput` before `askAgent`), `agentConverseService.ts` (`askAgent(principal, input: AgentTurnInput)`),
`agentChannelChatRoute.ts` (same resolver; passes the conversation's pinned `agentRevisionId` when `conversationId`
is given), `openapi/paths/mcpConversePaths.ts` (+`GET /api/v1/mcp/converse/tools`, tag "MCP Converse"),
`backend/tests/unit/operatorCopilot/catalogCoverage.ts` (exclusion: `GET /mcp/converse/tools` — agent-audience
read surface, not operator-facing), frontend `components/dashboard/chat-message-thread.tsx` (render
`inputMetadata.routine` as a tool-call block: name + key/value list; fall back to `content`).

Eval harness (SC-002): `eval/suite/caseSchema.ts` (`routineInvocation?: { toolName, input }`, `query` optional
when present), `workbenchReplayRunner.ts` (`routineInvocation` → `PrepareChatSessionInput`; ~570 lines, additive),
`eval/suite/traceAssertions.ts` (+`turn_skips_skill { skillName }`), fixtures
`backend/tests/fixtures/conversation-quality/routines.ts` (`startReturnRoutine`: slots `orderId` required text,
`reason` text; steps `ask_order` → `ask_reason` → `create_return` (skill `create_return_ticket`) → `done`;
`exposure: { enabled: true, toolName: "start_return" }`) and `cases.ts` (three cases: transcript via
`routineStartState` with both slots, invocation with both slots — both assert `routine_step_reached create_return`
+ `turn_uses_skill create_return_ticket`; invocation with `orderId` only asserts `routine_step_reached ask_reason`
+ `turn_skips_skill`). `backend/scripts/runEvals.ts` seeds the new fixture routine for the live suite.

Tests first: `backend/tests/unit/routines/agentToolDescriptor.test.ts` (slot → schema table; zero-slot routine →
empty object schema), `routineInvocationValidator.test.ts` (required, type, format email/date, unknown field →
field-level errors), `agentToolCatalog.test.ts` (published + enabled + exposure.enabled only; draft-only exposure
absent — edge case), `directInvocationActivator.test.ts` (activate with variables; unknown → null; suppressed →
null), `backend/tests/unit/chat/agentTurnInput.test.ts` (400 with `details.errors`, 404 unknown tool, no message
written — assert on a fake message repository), `backend/tests/integration/routine-invocation.integration.test.ts`
(AS-2 fast-forward + envelope `routine.status`; AS-3 nothing recorded; AS-4 approval step →
`waiting_for_approval`; AS-5 `once_per_conversation` already completed → normal answer + `routine.status =
"completed"`, and a completed `always` routine re-enters with no LLM call; AS-6 invocation while a *different*
routine is active → existing interruption rules, the active routine's state is what the envelope reports, and an
unrelated completed routine never captures the turn (the reentry/correction no-op); AS-7 disabled exposure →
`routine_tool_unknown`; AS-9 REST body parity incl. SSE `done`),
`backend/tests/contract/mcp-converse.contract.test.ts` (tools path; `ask` request union; response schema now
asserted), `backend/tests/unit/eval-suite/suite-runner.test.ts` (invocation case runs through the fake stack),
`backend/tests/unit/message-repository*.test.ts` (round-trips `routine_invocation` metadata).

Observability: counter `converse_turns_total{input_kind: message|routine_invocation}` *(hook: `caller_kind` label
in US6)*; `routine_invocations_total{outcome: started|validation_failed|unknown_tool|reentry}`; validation-failure
log at `info` with field paths only; the turn spine gets attributes `routine.invocation.tool_name`,
`routine.invocation.slot_count`, `routine.invocation.prefilled_count` set where the provider builds the activator
(`chatService.ts:831` `traceOperation` is the existing span; attributes attached via the turn trace envelope, not
a new span). No slot values anywhere.

Regenerate OpenAPI + SDK snapshot + MCP `sync:openapi`. Docs: `docs/mcp-client-setup.md` (Converse calls:
`tools`, the `routine` body, validation errors), `docs/typescript-sdk-basic-usage.md`, `docs/authoring-routines.md`
("What a calling agent sees"), `docs/human-takeover.md` only if it lists message kinds, code map (Chat + Routines).

### Slice 4 — MCP package: per-session catalog and typed tools (FR-013 `tools/list`, FR-005)

Files: `src/converseApiAdapter.ts` (`tools(sessionToken, ctx)`; all types from `generated/openapiTypes.ts`),
`src/auth/sessionStore.ts` (`AccessSessionRecord.toolCatalogKey?: string`), `src/state/redisRuntimeStore.ts`
(serialise it; absent on old records → default catalog), `src/auth/authService.ts:73-82` (after exchange, fetch
the catalog, key = `sha256(JSON.stringify(tools))` prefix, save it and the descriptors alongside the session or
refetch on server creation — refetch is the default, it needs no store shape beyond the key),
`src/http/sessionServerManager.ts` (`toToolCatalogKey(session)`; `createSessionHandle` fetches descriptors with the
session's converse token and passes them to `createRadiosoMcpServer({ routineTools })`; servers are cached per
catalog key and shared by sessions with identical catalogs, which is safe because all per-call state comes from
`resolveExecutionContext`; the cache becomes bounded — LRU with a small cap (e.g. 64) and idle TTL — because the
key space is now one entry per distinct tool set and the existing `evict()` has no callers), `src/server.ts` (accept `routineTools`), `src/tools/routineTools.ts` (new:
descriptor → `GenericToolDefinition`; `execute` calls `converseAdapter.ask(token, { routine: { toolName, input: args } })`
and returns `{ data: envelope, summary: envelope.answer.text }`), `src/tools/routineToolSchema.ts` (descriptor
`inputSchema` → the SDK's schema input; see open decision 8), `README.md` (`## Agent Converse Flow` no longer says
"only `ask_agent`"), `docs/mcp-client-setup.md` (tool list per agent; catalog fixed for the session's lifetime —
`notifications/tools/list_changed` is a non-goal).

Tests first: `tests/converseTools.test.ts` (tool names = `ask_agent`, docs tools, one per descriptor; call forwards
`routine` body; `structuredContent` is the envelope), `tests/sessionServerManager*.test.ts` (two sessions with
different catalog keys get different servers; same key shares; legacy record without key gets the default),
`tests/openapiSync.test.ts` unchanged (drift gate). `pnpm run smoke:all` against a local backend with one exposed
routine (manual gate; the harness in `testing/remoteSmokeHarness.ts` gains a tools/list assertion).

*(hooks)*: `ask_agent` description from a pure formatter (US6) plugs into `createConverseToolDefinitions({ agent, tools })`;
`get_conversation_updates` (US5) is a second static tool; cards (US3) consume `AgentToolCatalogPort` unchanged.

## Contract-change review

- OpenAPI: all changes are additive — new optional response fields on `POST /mcp/converse/ask` and
  `POST /agents/{agentId}/chat`; request bodies widen to a union (`{ message }` still valid); new `GET
  /api/v1/mcp/converse/tools`; optional `exposure` on routine bodies; `UserMessageInputMetadata.method` gains a
  value on history reads. Regenerate `backend/openapi.{json,yaml}`, `typescript-sdk` (`pnpm run sync`), and the MCP
  package (`pnpm run sync:openapi`) in the same change; CI fails on either snapshot drifting.
- Message queue / worker: **no change**. Every new path is synchronous on the API process. A routine admitted by
  invocation emits action steps through the existing conversation-action outbox with unchanged payloads; the
  document worker and AMQP queues are not on any of these paths. Queue docs/tests: none affected.
- Engine contract (`@radioso/conversation-contract`): unchanged. `Routine.metadata` gains keys (untyped record).

## Decisions (resolved 2026-09-21; spec amended to match)

1. **REST `answer` stays a string.** Shared contract = envelope core (`conversationId`, `answerCoverage`,
   `ownership`, `routine?`, `traceId?`); MCP keeps `answer: { text, citations }`, REST keeps `answer: string` +
   `citations[]`. Citations stay `ChatCitation` (`sourceUrl`). Spec FR-001/FR-002/FR-004 updated.
2. **Recorded text for an invocation** carries values verbatim (`toolName {json}`), exactly as if a person had
   typed them, so LLM-visible history matches chat; `inputMetadata.routine` holds the structured form. Operator
   views show the values as they show a typed message — the pushed-context redaction covers host-supplied identity
   facts, not what a caller chose to send (review 2026-09-22 found the earlier "redact email slots" clause had no
   coherent implementation; spec FR-016 amended).
3. **Frozen name semantics** as proposed: once published with exposure enabled, the lineage's `toolName` is frozen
   even while later disabled; a new name means a new routine. Duplicate detection counts enabled exposures only.
4. **`answerCoverage` always present** with the `not_recorded` fallback. Implementer verifies
   `activity-trace-detail.tsx` tolerates it (history already emits it).
5. **`pendingInput`** = every declared required slot not yet filled, plus the current step's unfilled optional
   slots — a calling agent can supply everything in one re-call. Spec FR-003 updated.
6. **No new publish-refusal audit event.** 4xx diagnostics and `copilot.proposal.apply_failed` are sufficient.
7. **Catalog vs pinned-revision race** accepted for v1; documented in `docs/mcp-client-setup.md`.
8. **MCP SDK schema input**: implementer verifies whether `ToolDefinition.inputSchema` accepts plain JSON Schema;
   if not, `routineToolSchema.ts` is a five-shape typed converter with unit tests, not a general one.
9. **Reentry refusal via tool** still reports: the turn answers normally and the envelope carries
   `routine: { toolName, name, status: "completed", pendingInput: [] }` so the caller learns why nothing started.
   The reporter derives this from the suppressed/completed routine state the activator declined. Spec AS-5 updated.
10. **SC-003** is a follow-up after US6; marked as such in the spec.
11. **FR-013 is delivered without `get_conversation_updates`** (US5). Slice 4's `tools/list` is `ask_agent` +
    one tool per descriptor; the reserved-name list already holds `get_conversation_updates` so US5 adds it
    without a rename.

## Verification per slice and merge gates

- Backend: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json` and the test tsconfig; targeted
  `pnpm exec vitest run <files>`; then `pnpm run test:unit`, `pnpm run test:contract` (regenerates OpenAPI first),
  `pnpm run test:integration` (slices 1–3; disposable DB per `packages/integration-test-support`).
- Packages: `cd packages/routine-definition && pnpm test` (slice 2); `cd packages/conversation-engine && pnpm test`
  (unchanged, run once in slice 3 as a no-regression check); `cd packages/radioso-mcp-server && pnpm run build && pnpm test`
  (slices 1, 4) and `pnpm run smoke:all` (slice 4, needs a running backend).
- Frontend: `cd frontend && pnpm test`; Playwright `routine-document-editor.spec.ts` (slice 2), `assistant-history`
  or activity spec covering the invocation block (slice 3).
- Repo root after every slice: `pnpm run lint`, then `pnpm exec tsc` in touched packages (the
  `no-unnecessary-type-assertion` autofix trap), `pnpm run lint:dead-code:ci`.
- Snapshots: after slice 2's migration, `db:types` **and** `db:schema` committed together; after slices 1–3,
  `backend/openapi.{json,yaml}`, `typescript-sdk/openapi/*` + `src/generated/types.ts`, and
  `packages/radioso-mcp-server/src/generated/openapiTypes.ts` regenerated and committed; after any
  `docs-portal/content` edit, `pnpm --filter @radioso/product-docs run sync`.
- Merge gates: PR title in Conventional Commits; deterministic eval suite green with the three new cases; live
  `pnpm run evals:ci` against the committed baseline once before merge (routine fixtures changed); copilot
  deterministic suite green with the `propose_routine_exposure` case; SDK and MCP snapshot jobs green.

## Implementation notes (slice 1, 2026-09-21)

Where the code differed from the file-level plan above:

- **OpenAPI components.** `AssistantChatResponseSchema` is shared with `/assistant/chat`, which never carries the
  envelope, so it is untouched. The envelope is `AgentReplyEnvelopeCore` (registered once in
  `openapi/schemas/agentReplyEnvelopeSchemas.ts`), referenced by `McpConverseAskResponse` (= core + `answer`) and
  `AgentChannelChatTurnResponse` (= `ChatResponse` ∧ core ∧ required `citations[]`); `AgentChannelChatResponse` is
  that turn shape | `ChatBootstrapResponse`, because a `startConversation` greeting has no turn and no envelope.
  The plain `mcpConverseAskResponseSchema` in `http/schemas/mcpConverseSchemas.ts` is gone; the registered component
  is the single definition.
- **`traceId`** comes from `turnTrace.spine.traceId` (the envelope has no top-level `traceId`).
- **Reporter port.** The routine turn report is routine data, so routines owns it: `RoutineTurnState`,
  `RoutinePendingInput`, `RoutineTurnStatus`, and `RoutineTurnReporter` live in `routines/turnReport.ts` (exported
  through `routines/public.ts`); `chat/contracts/routineTurnState.ts` re-exports them under chat-side names, so no
  file under `routines/` imports from `chat/`. The reporter's input is `{ state, awaitingDecision? }`: a handoff terminal already saves `status: "completed"`, so `handedOff`
  added nothing. An empty `state.path` (an activation turn that re-asks the root step) resolves to `rootStepId`.
- **`answerCoverage` fallback** is produced by the two `ChatResponse` producers (`chatTurnLifecycle.ts` and
  `suppressedHumanOwnedResponse`) with the request message id as both originating ids; the builder's own backstop
  carries empty ids and is not reachable from those producers.
- **`ownership` on a handoff turn** is `{ human_owned, suppressed: false }` (set by the lifecycle), so the caller learns
  the conversation changed hands on the turn that handed it off, not only on its next call.
- **`routine` is agent-facing only.** `presentChatPayload` strips it; the REST agent route and the SSE `done` frame
  (`agentEnvelope: true`) re-add it through the envelope, so `/assistant/chat` and public chat never expose routine
  names to visitors. The REST agent route always emits `citations` (empty when none) to match MCP.
- **Not in slice 1:** `toolName` (needs the slice-2 exposure metadata) and Decision 9 (reporting a declined reentry —
  the reporter only describes a state the turn saved; the direct-invocation activator in slice 3 owns that case). A
  turn where an active routine yields to normal answering saves no state, so it carries no `routine` either.
- **Test app** now wires `conversationOwnershipReader` into `ChatService` (as production does) so the human-owned
  path runs in integration tests.

## Implementation notes (slice 2, 2026-09-21)

Where the code differed from the file-level plan above:

- **Migration number** is `194_routine_definition_exposure.sql` (193 was the latest on the branch).
- **Pattern lives in the validator, not the schema.** `routineExposureSchema` bounds the shape (trimmed,
  `toolName` ≤ 63, `description` ≤ 500, both may be empty) and exports `routineExposureToolNamePattern`;
  `validator.ts` reports `exposure_tool_name_invalid` / `_reserved` / `exposure_requires_ungated_activation`
  as diagnostics **only while `exposure.enabled`**. A draft can therefore hold a half-typed name and the
  editor shows the note the way it shows an unreachable step, instead of the save failing with a 400 —
  which is what the "invalid name shows the diagnostic" journey needs. A disabled block is inert.
- **Ray rides the field patch, not an op.** `routineFieldPatchSchema` (an object of optional fields, not
  an `op` list) gains `exposure`; `propose_routine_exposure` takes flat `{ routineId, enabled, toolName,
  description }` and calls the routine adapter's `draftEdit` with `{ exposure }`, so preview/apply/reconcile
  are the existing edit path and the card has one producer. `projectRoutineForReview` gains `exposure`.
  Governance entries: `capabilityProvenance`, `operatorMcpDisposition`, `fieldParity` (permanent
  exclusions; the tool's `enabled` is the exposure switch and coincides with the body's routine `enabled`),
  and `docs/operator-mcp.md`.
- **Frozen-name baseline.** `validateExposureAcrossSnapshot` freezes any non-empty `toolName` the
  currently published snapshot carries for a lineage (enabled or not), so Decision 3 holds with one
  previous snapshot; a name typed but never enabled is frozen once published too. Duplicates count
  routines that can serve (`enabled && exposure.enabled`), matching the structural gate's parked-routine rule.
  The repository loads `agents.published_revision_id` → `agent_revisions.snapshot` inside the candidate and
  publish transactions; `describeCandidateRelease` is unchanged (the candidate was already gated).
- **Persistence.** The block is present iff `exposure_tool_name IS NOT NULL` (an empty string is a present,
  unnamed block). No table-level uniqueness.
- **Frontend.** `RoutineBlockDoc` (`packages/routine-document`) and `RoutineFormState` carry `exposure`
  through their round-trips; `updateExposure` lives in `lib/routine-document-edits.ts` beside
  `updateActivation`; the editor is `RoutineExposureEditor` inside the "Starts when" editor, and the reader
  line names the tool. Exposure diagnostics carry `exposure.*` locations and render in the routine-level list.
- **Tests** landed in the existing files rather than new parallel ones: AS-8 in
  `agent-revision-publication.integration.test.ts`, the repository round-trip in
  `routine-definition-repository.integration.test.ts`, transforms in `routine-form.test.ts` and
  `routine-document-edits.test.ts`, the journey in `routine-document-editor.spec.ts` (the e2e mock validator
  mirrors the grammar rule). The deterministic copilot case `routine-exposure-proposal` has no live baseline
  entry yet; the live diff files it under `newCases` until `evals:copilot:update-baseline` runs.
- **Observability:** audit metadata on `routine_definition.create/update` gains `exposureEnabled` and
  `exposureToolName` (never the description); no new runtime path, so no new logs, metrics, or spans.


## Implementation notes (slice 3, 2026-09-22)

Where the code differed from the file-level plan above:

- **`RoutineInvocation` is `{ toolName, input }`.** The lineage id stays on the descriptor the call
  validated against (`AgentTurnInput.descriptor.routineLineageId`): the tool name is the routine's
  identity within a release, nothing downstream reads the lineage, and the eval harness can then
  author an invocation without knowing lineages. The type is owned by `routines/exposure/
  routineInvocationValidator.ts` and re-exported through `chat/contracts/routineInvocation.ts`.
- **Rendering happens at the entries, not in the preparer.** `assistantChatService.ts` and the
  replay adapter (`scripts/evalRunnerAdapter.ts`, via `conversationQualityCaseTurnText`) set
  `query = renderRoutineInvocation(invocation)`; the preparer keeps `query` required, passes
  `routineInvocation` through to the session, and derives `inputMetadata` from it when recording
  the user message. `ChatService` and `chatTurnAssembly` are pass-through only.
- **Decision 9 mechanism.** The activator returns null and no routine state is saved, so the
  lifecycle's `describeRoutineTurn` has nothing to describe. `RoutineTurnReporter` gained
  `describeDeclined()`; `routines/exposure/directInvocationTurn.ts` pairs the direct activator with
  the silenced reentry/slot-correction gates and a reporter whose `declinedRoutineId` reads the
  activator's outcome; `chatTurnAssembly.attemptRoutineTurn` writes the description onto
  `PreparedSession.declinedRoutine` when the engine yields, and the lifecycle falls back to it. The
  session is the one object every normal-answer branch already hands the lifecycle.
- **`decisionMetadata`** is the contract's `ClarificationDecision` (`auto_pick`, reason `priority`)
  with the metadata-level `reason: "direct_invocation"`, which is what the clarification stage
  records; the string is not a new `ClarificationAutoPickReason`.
- **Catalog readers.** `createAgentToolCatalog({ agents, publishedRoutines })` takes two narrow
  readers; the agent's `description` is `null` until US6. Composition (`app/composition/
  agentToolCatalog.ts`) reads the pinned revision or the current published one. The test app
  composes the same port over `routineDefinitionRepository.listActiveByAgent`, the source its own
  routine provider serves from, so the catalog and the activator agree there.
- **`turn_uses_skill` now sees routine skill steps** (a `skill_dispatched` entry in the routine
  subtrace), which the SC-002 cases need; `turn_skips_skill` is its negation over the same set.
  In the live suite the fixture's `create_return_ticket` is not a registered skill, so the dispatch
  is recorded with `skillStatus: "failed"` (`unknown_skill`) on both the transcript and the
  invocation path; the parity assertion is on the dispatch, not its success.
- **Error codes** ride `error.details.code` (`routine_tool_unknown`, `routine_invocation_invalid`)
  with `error.code` staying `not_found` / `bad_request`, matching the converse service's existing
  `mcp_converse_*` convention; `notFound` gained an optional `details` argument.
- **Metrics** `converse_turns_total{input_kind}` and `routine_invocations_total{outcome}` are
  emitted from `resolveAgentTurnInput` (`message`/`routine_invocation`, `validation_failed`,
  `unknown_tool`) and from the turn provider's `onOutcome` (`started`; `reentry` for both a
  re-admitted and a declined completed routine; `unknown_tool` when the tool is absent from the
  turn's pinned release — Decision 7's race — also logged at `warn`).
- **Test app fidelity.** `InMemoryRoutineStateStore` gained `loadCompleted`, without which the
  engine never suppresses a completed routine and AS-5 cannot be observed.
- **Frontend** history types come from `UserMessageInputMetadata`, now one OpenAPI component
  (`method` gains `routine_invocation`, plus `routine`); `chat-message-thread.tsx` renders the
  block (`data-testid="routine-invocation-block"`), and the request-side `inputMetadata` schema is
  unchanged so a client cannot claim the method.

## Implementation notes (slice 4, 2026-09-22)

- **Descriptors are stored on the session, not refetched.** `AccessSessionRecord.toolCatalog` is
  `{ key, tools }` (one field, consistent by construction), written by `authService` right after
  the exchange's `validate` and serialised by the Redis store as plain JSON (the record's only
  secret stays the encrypted converse token). This makes "catalog fixed for the session's
  lifetime" hold across server-cache eviction and across MCP replicas, and the http layer needs
  no backend call to build a server. A record without the field renders the static tools only.
- **Decision 8: pass-through.** `ToolDefinition.inputSchema` needs a Standard Schema object, and
  the SDK ships `fromJsonSchema()` (AJV-backed, `email`/`date` formats, `additionalProperties`
  honoured) for exactly that; `tools/routineToolSchema.ts` is a one-call wrapper. No five-shape
  converter. The SDK rejects a schema miss as a tool result with `isError: true` before the
  handler runs, so the backend only ever sees valid input from MCP.
- **Server cache**: LRU keyed by catalog key, 64 entries, 15-minute idle TTL, concurrent first
  requests for one key coalesced. Evicted servers are dropped without `close()`: in-flight
  requests keep their reference and the JSON-response transport holds no timers.
- **Name collisions** with static tools are filtered in `server.ts` with a `warn` (injectable,
  defaults to `console.warn`); the reserved-name list on the backend makes this unreachable in
  practice.
- **Smoke**: the harness seeds a `start_return` routine through the test app's
  `routineDefinitionService.createDraft` (a draft is already active there) and asserts
  `tools/list`, a valid call's envelope, a schema-rejected call, and that the audit log carries the
  tool name but no slot value; the Redis smoke asserts the second node lists the pinned catalog.
- **Observability**: routine tool calls ride the existing `tool.executed`/`tool.failed`/`tool.denied`
  audit events with `toolName` only; nothing else new.
