# Feature Specification: A2A protocol binding for published agents

**Feature Branch**: `feat/a2a-protocol-binding`
**Created**: 2026-11-09
**Status**: Draft (revised after adversarial review, 2026-11-09)
**Issue**: none yet — file one before approval
**Builds on**: `specs/1290-agent-consumable-service-surface/` — replaces its "Full A2A protocol" non-goal for the JSON-RPC binding; streaming and push notifications stay out (see Non-goals)
**Input**: Radioso publishes an A2A Agent Card, but a client that speaks A2A and not MCP finds the card and cannot use it. Make a published agent answer A2A v1.0 over JSON-RPC, so the card's promise is true.

## Why this exists

- **The card points A2A clients at a door they cannot open.** `renderA2aAgentCard.ts` pins the card to protocol `0.3.0` and sets `preferredTransport: "MCP"` with `url` at the MCP endpoint (`backend/src/modules/agentDiscovery/domain/renderA2aAgentCard.ts:10,17,75-76`). The backend has no JSON-RPC handling; it lives only in `packages/radioso-mcp-server`.
- **The card shape is a major version behind.** A2A v1.0.0 (Linux Foundation, 2026) makes these changes:
  - the top-level `url`, `preferredTransport`, and `protocolVersion` give way to an ordered `supportedInterfaces[]`;
  - the JSON-RPC methods are renamed (`SendMessage`, `GetTask`, …);
  - enums serialise as ProtoJSON names (`TASK_STATE_INPUT_REQUIRED`, `ROLE_USER`);
  - an `A2A-Version` header is added. A server answers `VersionNotSupportedError` (-32009) when the header is absent, because an absent header means 0.3.
- **MCP cannot stay on the A2A card as an interface.** `protocolBinding` is an open string, but any binding must implement every core A2A operation (spec §12). MCP does not.
- **The card is invalid under v1.0 even before transport.** "Arrays marked as required MUST contain at least one element" (§5.7). `AgentCard.skills` and `AgentSkill.tags` are required, but today `tags` is always `[]`, and an agent with no exposed routines renders `skills: []`.
- **The turn already computes what an A2A task needs.** Spec 1290 gives every agent-caller turn:
  - walk-in and grant access with rate budgets;
  - one converse entry that accepts a message or a typed routine invocation (`AgentConverseService.askAgent`);
  - a reply envelope that reports routine status (`waiting_for_input`, `waiting_for_approval`, `completed`, …) and ownership (`ai_owned` | `human_owned`);
  - cursor reads of later messages, human replies included (`ConversationUpdateReader`, behind `mcpConverseMessagesRoute.ts`).

  A2A tasks are another serialisation of that state, plus a small amount of task bookkeeping the engine does not keep.

## Where it runs

A new backend module serves `POST /a2a/{publicId}` directly, as the backend already serves the agent cards and public chat sessions to internet callers.

The alternative is hosting the binding in `packages/radioso-mcp-server`, which already has JSON-RPC framing and walk-in plumbing. It was rejected for three reasons:
- tasks are durable conversation-linked state, which belongs in Postgres under conversation retention;
- the edge would need a second, task-shaped backend contract and an extra network hop per call;
- the edge's signed source proof exists because the edge forwards on the caller's behalf. A backend route observes the caller's source itself, as the card and public-chat routes do.

## Boundaries (what each part knows)

| Part | Knows | Must not know |
|------|-------|---------------|
| `backend/src/modules/a2a` (new) | A2A v1.0 JSON-RPC wire shapes, dispatch, and error mapping; sealed context tokens; task records; the pure mapping from a turn's outcome plus later messages to a task state | Routine internals, MCP, card JSON |
| `backend/src/modules/chat` (converse service, turn report) | The envelope core; an internal turn report that also carries the routine execution id (not on the public envelope); channel-aware converse audit | Whether the caller speaks MCP or A2A, beyond the source-channel value |
| `backend/src/modules/settings` (converse sessions and origins) | Walk-in and grant origin checks; issuing a converse principal for a channel without minting a session token; a grant path that opens a fresh conversation per caller-held context | A2A shapes |
| `backend/src/modules/agentDiscovery` | The v1.0 card shape, built from the interface list and extension params it is handed | A2A methods, tasks |
| `backend/src/app/composition` | Mounts the A2A routes; derives the A2A endpoint URL from the existing public API base; binds the task table's retention rule | Product rules |
| `backend/src/shared/domain/conversationSource.ts` | `a2a` is an agent source channel | — |
| `packages/radioso-mcp-server` | Unchanged | — |

Dependency direction: the A2A module depends on the public ports of chat and settings; only composition depends on the A2A module. No domain module learns that A2A exists.

Changes outside the new module, all small:

| Change | Owner | Why |
|--------|-------|-----|
| The `AgentConversePrincipal.sourceChannel` literal (`agentConverseSession.ts:18`) and the session payload schema (`publicChatSession.ts:41`) widen from `"mcp"` to `"mcp" \| "a2a"`; `askAgent` stops hard-coding `"mcp"` (`agentConverseService.ts:92,113`) | settings, chat | A2A turns must record `sourceChannel = "a2a"` |
| A port that issues a principal for a verified origin without a session token, re-verified on every call through the existing origin verifier | settings | `toPrincipal` is private today (`agentConverseSessionService.ts:139`) |
| The grant origin path can open a fresh conversation per caller-held context, instead of the one conversation pinned per grant version (`converseExchangeOrigins.ts:92`) | settings | Each A2A context is its own conversation |
| The per-turn converse audit records the channel; A2A turns are not recorded as `mcp_converse.ask` (`agentConverseAudit.ts:69`) | chat | The security feed must say which door was used |
| The internal turn report carries the routine `executionId` | chat, routines | A routine switch inside a context must close one task and open another |
| `a2a` joins `AGENT_SOURCE_CHANNELS` | shared domain | `callerKind = "agent"`, directive fact, history filter |

## How A2A maps onto a Radioso conversation

This mapping is the load-bearing decision; the stories and requirements below refer to it.

| A2A | Radioso |
|-----|---------|
| **Context** (`contextId`) | One conversation. The `contextId` is a sealed token minted by the first `SendMessage` that carries none. It carries the conversation's public session id, the origin it was opened under (walk-in `publicId`, or grant id and version), and its expiry, encrypted with the existing field-encryption keys. There is no context table. Every request re-verifies the origin, so rotating the public id, turning walk-in off, or revoking the grant ends the context with no sweep |
| **Plain answer**: no task open in the context, and the turn ends with the AI owning the conversation, no routine in flight, and no human message since the caller's last message | A `Message` response (`ROLE_AGENT`); no task record |
| **Task**: a stretch of work that is not a plain answer | A `Task` with a server-minted id (≥ 128 bits, independent of routine ids). It opens when a turn starts a routine, finds the conversation human-owned, or finds human messages the caller has not seen. It ends when the turn's outcome no longer needs it |
| **Open tasks per context** | At most one, enforced by a partial unique index. The engine runs one thread and keeps one routine state per conversation |

Task state after a turn, or on a read. The first matching row wins:

| # | Condition | Task state | `status.message` |
|---|-----------|------------|------------------|
| 1 | Ownership `human_owned`, and a human or agent message has arrived since the caller's last message | `TASK_STATE_INPUT_REQUIRED` | The latest such message (`ROLE_AGENT`) |
| 2 | Ownership `human_owned` (with or without a routine in flight, including an authored routine end that hands off) | `TASK_STATE_WORKING` | The turn's reply, if any |
| 3 | AI-owned, and an agent or human message has arrived since the caller's last message, observed on read (e.g. after an operator's approval decision, or a person's reply written just before a handback) | `TASK_STATE_INPUT_REQUIRED` | That message |
| 4 | Routine `waiting_for_approval` | `TASK_STATE_WORKING` | The agent's reply |
| 5 | Routine `waiting_for_input` or `active`, with the same execution id as the open task's | `TASK_STATE_INPUT_REQUIRED` | The agent's reply; `pendingInput[]` in extension metadata |
| 6 | Routine in flight with a different execution id than the routine the open task follows | The open task ends `TASK_STATE_CANCELED` (reason `routine_replaced`); a new task opens and takes rows 4–5. An open task of human ownership adopts the routine instead | The reply goes on the new task |
| 7 | Invocation outcome `declined` (checked before row 8, because a declined invocation reports its routine as completed) | `TASK_STATE_REJECTED` | The agent's reply |
| 8 | Routine `completed` this turn | `TASK_STATE_COMPLETED` | None; the reply is the task's artifact |
| 9 | No routine in flight, AI-owned, and the open task was a stretch of human ownership (handback) | `TASK_STATE_COMPLETED` | The turn's reply, if any |
| 10 | No routine run still active after the turn (read from the routine state, so expiry counts), AI-owned, and the open task followed a routine that did not complete | `TASK_STATE_CANCELED` (reason `routine_ended`) | The turn's reply |

A routine that yields to an off-topic message stays active, so its task stays `TASK_STATE_INPUT_REQUIRED` with the turn's reply as status message and keeps its last `pendingInput`.

Rules that hold across the table:
- Invocation outcomes `not_started` and `reentered` need no rows of their own: the routine actually in flight decides the row.
- Status messages and artifacts carry only text a turn produced or a person wrote. A transition no turn produced carries the state and a structured reason, never copy written in code.
- A2A's `TaskStatus` has no reason field, so the reason travels under `metadata[<extension URI>].reason` when the Radioso extension is active.

## Security model

For a walk-in caller, `contextId` and `taskId` are the only authority to continue or read a conversation. A2A frameworks copy them into LLM context, traces, and sub-agents, which spreads them far more widely than an MCP session token kept in a transport header. Therefore:
- Ids are opaque. Context tokens are encrypted, so the workspace and agent ids never show. Task ids are random.
- A walk-in context expires with the walk-in session's absolute lifetime (`publicChatSession.ts:12`).
- `GetTask` history is the task's own messages, never the whole conversation.
- `ListTasks` never crosses contexts.
- Ids never appear in `ErrorInfo.metadata`, logs (except hashed), or metric labels.
- Unknown, expired, and other-caller ids answer identically, so they cannot be told apart.

A caller that wants stronger binding uses an operator-minted grant. A context opened under a grant continues only under that grant.

## User Scenarios & Testing

### User Story 1: An A2A client gets an answer (Priority: P1, slice 1)

A visiting agent built on an A2A v1.0 SDK reads the card, sends a question, and gets an answer, with no MCP client and no Radioso-specific code.

**Why this priority**: This is the claim the card already makes.

**Independent Test**: An e2e test points an off-the-shelf A2A v1.0 client at the card URL of a walk-in fixture agent. The client sends `SendMessage` and receives a `Message` with a `contextId`. A second send with that `contextId` continues the same conversation.

**Acceptance Scenarios**:

1. **Given** a published agent, **When** its card is fetched, **Then** it is a valid v1.0 card. Its one interface is `{ protocolBinding: "JSONRPC", protocolVersion: "1.0" }` at the A2A endpoint. It has at least one skill, every skill has at least one tag, and there are no v0.3 top-level fields.
2. **Given** walk-in is on, **When** a client sends `SendMessage` with `A2A-Version: 1.0`, no credential, and no `contextId`, **Then** a conversation opens with `sourceChannel = "a2a"` and `callerKind = "agent"`, and the response is a `Message` carrying a `contextId` and the reply as a text part.
3. **Given** that `contextId`, **When** the client sends again with it, **Then** the same conversation continues.
4. **Given** walk-in is off, **When** a client sends without a credential, **Then** it is refused, and the refusal reveals no more than the card does. **When** it sends an operator-minted grant as `Authorization: Bearer`, **Then** it is served, and each new context is a new conversation.
5. **Given** no `A2A-Version` header, or `0.3`, **Then** the request fails with -32009.
6. **Given** a retry of the same `messageId` in the same context, **Then** the original result is returned and no second turn runs.

---

### User Story 2: A calling agent completes a routine over several turns (Priority: P1, slice 1)

**Why this priority**: "Answer, act, hand off" is the product, and A2A's task lifecycle is how an A2A caller sees "act".

**Independent Test**: A fixture agent's routine collects two required slots.
1. A message that starts the routine returns a `Task` in `TASK_STATE_INPUT_REQUIRED` with the agent's question.
2. Replying with the `taskId` reaches `TASK_STATE_COMPLETED` with an artifact.
3. `GetTask` returns the same state with the task's history.
4. `ListTasks` with the `contextId` lists the task, newest first.

**Acceptance Scenarios**:

1. **Given** a turn that activates a routine still needing a slot, **Then** the response is a `Task` in `TASK_STATE_INPUT_REQUIRED` whose status message is the agent's question.
2. **Given** that task, **When** the client sends with its `taskId` (or with only the `contextId`), **Then** the routine continues. When it completes, the task is `TASK_STATE_COMPLETED` and the final reply is its artifact.
3. **Given** an open routine task, **When** an off-topic message makes the routine yield, **Then** the task stays `TASK_STATE_INPUT_REQUIRED` and the routine continues on the same task afterwards. **When** the routine run is gone (it expired), **Then** the next turn ends the task `TASK_STATE_CANCELED` with reason `routine_ended`, and the reply is its status message.
4. **Given** a terminal task, **When** the client sends to its `taskId`, **Then** it fails with -32004.
5. **Given** any task, **When** the client calls `CancelTask`, **Then** it fails with -32002 (or -32001 if unknown).

---

### User Story 3: A person takes over, and the caller comes back (Priority: P2, slice 1)

**Why this priority**: Handoff is the third leg of the product. Without it, an A2A caller is stranded the moment a person steps in.

**Independent Test**:
1. Force a handoff; the task is `TASK_STATE_WORKING`.
2. Post a human reply from the Inbox. The next `GetTask` returns `TASK_STATE_INPUT_REQUIRED` with that reply.
3. The caller answers with the `taskId`. The message lands with no AI reply generated, and the task is `WORKING`.
4. The operator hands back. The next turn ends the task `TASK_STATE_COMPLETED`.

**Acceptance Scenarios**:

1. **Given** an operator who takes over between the caller's turns, or replies in a context that has only had plain answers, **When** the caller next sends, **Then** a task opens that carries the human messages the caller has not seen. The reply is never silently dropped.
2. **Given** a human-owned task, **When** a person replies, **Then** `GetTask` returns `TASK_STATE_INPUT_REQUIRED` with the reply, without the caller sending anything.
3. **Given** a routine waiting on an operator's approval, **Then** the task is `WORKING`. After the decision, a later agent message moves it to `INPUT_REQUIRED` on read (row 3). The precise routine state arrives with the caller's next turn (slice 2 reads it without a turn).

---

### User Story 4: A calling agent invokes an exposed routine with typed input (Priority: P3, slice 2)

A caller that activates the Radioso extension sends `{ routine: { toolName, input } }` and gets the same validation, recorded `routine_invocation` message, and routine state as an MCP caller.

---

### User Story 5: Operators see A2A callers (Priority: P3)

**Acceptance Scenarios**:

1. *(slice 1)* An A2A conversation carries an A2A source marker in Activity and Inbox, and the existing `callerKind = agent` filter and directive fact include it, with no new configuration.
2. *(slice 2)* The Channels → MCP "Share with agent developers" block lists the A2A card URL and endpoint.

### Edge Cases

- **Callers that don't track `contextId`.** Each `SendMessage` without one opens a new conversation. That conversation counts against the walk-in budgets (20 new walk-in conversations per source per hour, across agents) and is metered as a conversation. This is the same as an MCP client that opens a session per question. The connect guide tells A2A clients to reuse `contextId`.
- **Overlapping turns.** A second `SendMessage` on a context while a turn runs supersedes the first on the same instance (`ChatTurnSupersededError`). The superseded call answers a JSON-RPC error with reason `TURN_SUPERSEDED`. Task writes compare-and-set on a version, so a read computed from an older snapshot never overwrites a turn's result.
- **Retries.** A repeated `messageId` returns the original result. If the original is still running, the retry answers reason `TURN_IN_PROGRESS`.
- **Invalid id pairs.** `taskId` and `contextId` that do not belong together → -32602.
- **Foreign context.** A client-supplied `contextId` this server did not issue → -32602 with reason `CONTEXT_NOT_FOUND`; never silently replaced.
- **Unsupported parts.** File, raw, URL, or data parts in slice 1 → -32005. `acceptedOutputModes` is ignored; replies are `text/plain`.
- **Batches.** JSON-RPC batch requests → -32600.
- **Unknown agent.** An unknown, unpublished, or deleted `publicId` → 404, identically to the card.
- **Quota.** A workspace over quota is refused with a structured reason, as walk-in MCP is.
- **Unsupported methods.** `SendStreamingMessage` and `SubscribeToTask` → -32004. Push-config methods → -32003. `GetExtendedAgentCard` → -32004.
- **Expired routines.** A routine state expires after 30 minutes idle (`DEFAULT_ROUTINE_STATE_TTL_MS`). Slice 1 learns of this on the caller's next turn (row 10). Until then `GetTask` still shows `INPUT_REQUIRED`; slice 2 reads routine state, expiry included, without a turn.
- **Late human replies.** A human who replies after a walk-in context's 12-hour lifetime cannot reach the caller, the same as with MCP walk-in today.

## Functional Requirements — slice 1

### Agent card

- **FR-001** `GET /.well-known/agent-card/{publicId}.json` MUST render the A2A v1.0 card: `name`, `description`, `supportedInterfaces`, `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills`, and `documentationUrl` when the connect guide exists. It MUST NOT carry the v0.3 top-level `protocolVersion`, `url`, or `preferredTransport`.
- **FR-002** `supportedInterfaces` MUST hold one entry: `{ url: <A2A endpoint>, protocolBinding: "JSONRPC", protocolVersion: "1.0" }`.
- **FR-003** `skills` MUST always start with an `ask_agent` skill, because plain messages always work. That skill's `id` is `ask_agent`, its `name` is the agent's name, and its `description` is the agent's operator-written description. One skill follows per exposed routine (`id` and `name` are the tool name; `description` is the descriptor's). Every skill's `tags` MUST be its `id`: an identifier, not invented vocabulary. Modes are `text/plain`.
- **FR-004** `securitySchemes` MUST declare the grant bearer as an HTTP bearer scheme. When walk-in is off, `securityRequirements` MUST require it. When walk-in is on, `securityRequirements` is omitted: the bearer stays declared for callers that hold a grant, and A2A defines no meaning for an empty requirement.
- **FR-005** `capabilities` MUST be `streaming: false`, `pushNotifications: false`, `extendedAgentCard: false`. `extensions` MUST list the Radioso converse extension (`required: false`). Its `params` name the agent's MCP endpoint and MCP server card URL, so an MCP-only client reading the A2A card still finds MCP, and list each exposed tool's descriptor (`toolName`, `description`, `inputSchema`), because A2A skills carry no input schema.
- **FR-006** The A2A endpoint URL MUST be built from the public API base the backend already derives (`notificationRecipientPublicApiBase` in `composition/contactDelivery.ts`, moved to a shared helper), keeping any path prefix in the base. No new environment variable.
- **FR-007** CI MUST validate the card against the v1.0 card rules, including non-empty required arrays, and the vendored v0.3.0 fixture is removed. The A2A route is added to the exemptions in `openapi-route-coverage.contract.test.ts`.

### Endpoint and versioning

- **FR-010** `POST /a2a/{publicId}` MUST implement A2A v1.0's JSON-RPC 2.0 binding (`application/json`). Unknown, unpublished, and deleted ids answer 404, identically to the card.
- **FR-011** `SendMessage`, `GetTask`, `ListTasks`, and `CancelTask` MUST be served. Streaming methods answer -32004, push-config methods -32003, `GetExtendedAgentCard` -32004, and anything else -32601. Batches answer -32600.
- **FR-012** `A2A-Version: 1.0` MUST be accepted, as a header or as the `A2A-Version` query parameter (§3.6); the header wins when both are present. An absent version or any other value MUST answer -32009.
- **FR-013** Errors MUST carry a `google.rpc.ErrorInfo` entry in `error.data`, with domain `a2a-protocol.org` for A2A errors and a Radioso domain for Radioso reasons. `CONTEXT_NOT_FOUND` answers -32602. The server-side reasons (`TURN_SUPERSEDED`, `TURN_IN_PROGRESS`, `USAGE_LIMIT_EXCEEDED`) answer -32000, the JSON-RPC server-error code A2A leaves unassigned. Error data MUST NOT carry message text, ids, slot values, or identity attributes.
- **FR-014** In slice 1, caller messages MUST contain only text parts; anything else answers -32005, as does a non-JSON `Content-Type`. The request body is bounded like a chat message.

### Access and limits

- **FR-020** When `publicAgentAccessEnabled` is on, a `SendMessage` with no credential and no `contextId` MUST open a conversation through the walk-in origin check and the same per-source, per-agent, and backstop budgets as the MCP walk-in exchange (`mcpConverseWalkInRateLimiter.ts`). One `walkInConversationsPerHour` budget covers MCP and A2A.
- **FR-021** An operator-minted converse grant, sent as `Authorization: Bearer`, MUST authorize A2A on the same agent. Each new context opens a fresh conversation.
- **FR-022** Every request MUST re-verify the origin sealed in its context, through the same verifier MCP sessions use. A context continues only under the origin that opened it.
- **FR-023** Walk-in contexts MUST carry the walk-in session's absolute lifetime. Grant contexts live as long as the grant version.
- **FR-024** The security model above is normative.
- **FR-025** Turns MUST pass through the converse turn limiter with the same caller keys as MCP. `GetTask` and `ListTasks` MUST pass through the read limits `get_conversation_updates` uses. A limited request MUST answer HTTP 429 with `Retry-After` and `RateLimit-*` before JSON-RPC dispatch.
- **FR-026** A2A conversations MUST carry `sourceChannel = "a2a"` and `callerKind = "agent"`, and are metered as conversation replies. `source_channel` is free text, so no migration is needed for it.

### Tasks

- **FR-030** The mapping and precedence table above are normative.
- **FR-031** A task record MUST hold only references and state:
  - task id and conversation id;
  - the routine execution id it follows, if any;
  - the opening message id;
  - the id of the caller's last message;
  - a cursor for later messages;
  - state, reason, and state timestamp;
  - a version for compare-and-set.

  It MUST NOT copy message content. A partial unique index MUST allow one open task per conversation.
- **FR-032** The task table MUST be covered by conversation data retention: a `ConversationDataRetentionRule` bound in `composition/conversationRetention.ts`, plus data-subject export and erasure, like `RoutineStateRetention`.
- **FR-033** `SendMessage` MUST return when the turn finishes. A task the turn leaves `WORKING` is returned as `WORKING`, because it waits on a person for an unbounded time; callers poll `GetTask`. `returnImmediately` is accepted and changes nothing. v1.0 is itself inconsistent here: §3.1.1 also says `SendMessage` returns immediately.
- **FR-034** A message with a `taskId` continues that task. A message with only a `contextId`, in a context with an open task, continues the open task. Either way, the response is the task the turn ended in, which may be a new one (row 6). A message to a terminal task answers -32004.
- **FR-035** `GetTask` MUST recompute rows 1 and 3 from the messages after the task's cursor (`ConversationUpdateReader`) and store the result by compare-and-set. History is the task's messages only: caller messages are `ROLE_USER`, and agent and human replies `ROLE_AGENT`. `historyLength` follows the spec.
- **FR-036** `ListTasks` MUST return the tasks of the one context named by `contextId`, newest status first, with the `status` and `statusTimestampAfter` filters and the spec's pagination. Without `contextId` it returns an empty list.
- **FR-037** `CancelTask` MUST answer -32002 for any existing task, open or terminal, and -32001 for an unknown one.
- **FR-038** `SendMessage` MUST be idempotent on `(context, messageId)`: a repeat returns the original result without running a turn, for the context's lifetime. A grant context has no lifetime, so its receipts and finished tasks are pruned after 90 days. A context's first send cannot be deduplicated, because its conversation does not exist until that send opens it.
- **FR-039** No status message, artifact, or error MAY carry assistant copy written in code.

### Radioso converse extension

- **FR-040** The extension has a versioned URI on the docs portal that resolves to its reference page.
- **FR-041** A client activates it with the `A2A-Extensions` request header, and the server echoes the activated list in the response header. When activated, every `Message`, task status message, and artifact carries the envelope core under `metadata[<extension URI>]`: `answerCoverage`, `ownership`, `routine` (with `pendingInput`), `invocation`, `citations`, and `author` (`agent` | `human`). When it is not activated, no extension metadata is emitted.

### Operator surface

- **FR-050** Activity and Inbox MUST show an A2A source marker. The marker is read-only and is recorded as a copilot coverage-map exclusion. No operator setting is added: the walk-in toggle, per-agent budget, and grants govern both doors, so no Ray tool is needed.

### Docs and contract

- **FR-060** These docs MUST ship with the change:
  - the connect guide (`docs-portal/content/guides/agent-converse.mdx`) gains A2A client setup, including the `contextId` reuse advice;
  - `publish-an-agent.mdx` describes what the card advertises;
  - the extension's reference page;
  - `readme.md` lists A2A among the ways to reach an agent;
  - the new module has a `README.md` and a code-map entry;
  - the product-docs corpus is re-synced.
- **FR-061** The card schema change MUST regenerate the OpenAPI document, the TypeScript SDK snapshot, and the MCP package's generated client in the same change. The A2A endpoint is not added to Radioso's OpenAPI, because its contract is A2A v1.0.
- **FR-062** There are no worker, queue, or AMQP changes. Every path is synchronous on the API process.

## Functional Requirements — slice 2 (follow-up change)

- **FR-070** A chat-owned read of the current routine state and ownership without running a turn. It reads `routine_states` with expiry, so `GetTask` reflects approval decisions and expiry (row 10, reason `routine_expired`) without the caller sending anything.
- **FR-071** Typed invocation through the extension: when the extension is activated, `message.metadata[<extension URI>].routine = { toolName, input }`. It goes through `resolveAgentTurnInput` exactly as MCP does (1290 FR-014 to FR-016). Validation failures answer -32602 with `google.rpc.BadRequest` field violations (keys only); an unknown tool answers reason `ROUTINE_TOOL_UNKNOWN`.
- **FR-072** The Channels → MCP share block lists the A2A card URL and endpoint (read-only; coverage-map exclusion).

## Non-goals

- **Streaming** (`SendStreamingMessage`, `SubscribeToTask`). This is the natural next step once handoff waits matter.
- **Push notifications.** These are the real fix for a person replying hours later. They need outbound webhooks with their own auth, so they get their own spec.
- **gRPC and HTTP+JSON bindings, and A2A 0.3 compatibility.**
- **Outbound A2A.** Radioso agents already call agents that speak MCP, through external skills.
- **Caller-initiated cancel**, the extended agent card, and signed cards.
- **Changing the embed's discovery links.** The A2A card's extension params carry the MCP pointer instead.

## Key entities

- **A2A context token**: a sealed `{ publicSessionId, origin, expiresAt }`; not stored.
- **A2A task record**: FR-031.
- **Radioso converse extension**: a versioned URI. In the card, its params carry the MCP pointer and the tool descriptors. In responses, when activated, its metadata carries the envelope core. In slice 2, its metadata on a caller message carries a typed invocation.

## Assumptions

- Field encryption (`shared/infra/crypto/fieldEncryption.ts`) is configured in every deployment that serves walk-in, and its key rotation keeps old ciphertexts readable. Context tokens ride on that.
- A converse principal for a verified origin can be issued without minting a session token, and behaves the same in `askAgent`.
- An off-the-shelf A2A v1.0 SDK client is available for the e2e test.

## Observability

- **Metrics**:
  - `a2a_requests_total{method, outcome}`, where outcome is `ok`, an A2A error name, or a Radioso reason;
  - `a2a_task_transitions_total{to_state}`;
  - the existing `converse_turns_total` gains a `channel` label (`mcp` | `agent_api` | `a2a`).
  - No agent, context, task, or tool labels.
- **Logs**: refusals at `info` with the source digest and agent id, as walk-in MCP logs them. Context and task ids appear only hashed. No message text, slot values, or caller metadata.
- **Audit**: per-turn converse audit records the channel. Walk-in context issuance emits the same metric and `info` log as MCP walk-in issuance; neither writes an audit event.
- **Spans**: the turn spine gains `a2a.method` and `a2a.task_state`. Reads are not spans.

## Success criteria

- **SC-001** In the e2e suite, an off-the-shelf A2A v1.0 client with no Radioso-specific code completes this sequence against a walk-in agent with zero operator steps:
  1. read the card;
  2. `SendMessage`;
  3. reach a routine at `INPUT_REQUIRED`;
  4. `SendMessage` with the `taskId`;
  5. reach `COMPLETED`.
- **SC-002** Contract tests cover every method and error code in FR-010 to FR-014, and the A2A TCK's mandatory JSON-RPC checks pass if a v1.0 release of the TCK exists.
- **SC-003** CI validates the card against the v1.0 rules (FR-007).
- **SC-004** After a forced handoff and an Inbox reply, the next `GetTask` returns `INPUT_REQUIRED` with that reply. After handback, the next turn ends the task `COMPLETED`.
- **SC-005** MCP and A2A walk-ins draw on one per-agent budget, and a repeated `messageId` runs one turn (tests).

## Open questions

1. **Grant audience.** The draft reuses `mcp-converse` grants for A2A (FR-021). Should there be a separate audience?
2. **Late human replies.** Are push notifications the next spec?
3. **Caller identity.** Should the extension carry `signedIdentity`, as MCP `ask` does (1290 FR-033)?
