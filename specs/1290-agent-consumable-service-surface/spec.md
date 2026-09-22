# Feature Specification: Agent-consumable service surface

**Feature Branch**: `agent-consumable-service-surface`
**Created**: 2026-09-18
**Status**: Approved (2026-09-21)
**Issue**: #1290
**Input**: "Customer service platform for AI agents" — make it easy for a visitor's AI agent to discover, connect to, understand, and act through a business's Radioso agent without a human in the loop.

## Why this exists

A human visitor gets a chat bubble: discoverable on the page, no credential, a reply they can read. A visiting AI agent (Claude, ChatGPT, Cursor, a customer's own assistant) gets none of that today:

- **Reach requires a human.** The only agent-facing doors are the MCP converse surface and `POST /agents/:id/chat`, and both need a credential an operator mints in the dashboard and hands over (`backend/src/app/http/routes/agentRoutes.ts:112-118`, audiences `mcp` | `rest`). That is a partner-integration path, not walk-in customer service.
- **Nothing to discover.** `/.well-known` serves only `oauth-authorization-server` for the operator surface (`backend/src/modules/operatorMcpAuthorization/routes.ts:44`). No agent card, no server card, no link from the embedded widget.
- **One tool, one sentence.** The MCP catalog is `ask_agent` with a generic description (`packages/radioso-mcp-server/src/tools/converseTools.ts:11`). A caller cannot see what the business can *do*, only that it can be asked.
- **The reply is prose.** `POST /mcp/converse/ask` returns `{ conversationId, answer: { text, citations } }` (`traceId` is declared optional on the type but never populated) and discards the coverage assessment, ownership state, and routine state that the turn already computed (`backend/src/modules/chat/services/agentConverseService.ts:81-87`). A caller cannot tell "answered" from "punted" or "handed to a human".
- **Handoff strands the caller.** When a human takes over, an agent has no sanctioned way to come back for the reply. The public SSE pointer stream exists only for public-chat sessions (`backend/src/app/http/routes/publicChatRoutes.ts:771`), not for the converse surface.

The primitives are all there: a turn loop that already runs persona, directives, routines, and handoff for every channel; declared routine slots with types (`packages/routine-definition/src/index.ts:180-200`); the coverage verdict; signed visitor identity; source-keyed abuse control; and a generated OpenAPI contract the MCP package consumes. This spec adds the doors, the menu, and the machine-readable reply. It does not add a second conversation engine.

## Boundaries (what each part knows)

| Part | Knows | Must not know |
|------|-------|---------------|
| `packages/routine-definition` | The `exposure` block on a routine (tool name, description, enabled), validator rules for it | MCP, JSON Schema rendering, HTTP |
| `backend/src/modules/routines` (exposure helper) | How to turn a published, exposed routine into an **agent tool descriptor** (name, description, JSON Schema derived from declared slots); how to admit a routine by direct invocation with prefilled slots | Which transport asked; card formats |
| `backend/src/modules/chat` (converse service) | The **agent reply envelope** — assembling coverage, ownership, routine state, citations from a `ChatResponse` | Whether the caller is MCP or REST |
| `backend` agent discovery module (new) | A2A agent-card and MCP server-card JSON shapes; public agent id → card; the public MCP endpoint URL as injected configuration | Routine internals (consumes tool descriptors); how the MCP transport works |
| `packages/radioso-mcp-server` | MCP protocol; rendering descriptors as tools; session-bound catalog fetch; walk-in session exchange | Routines, slots, coverage semantics — it forwards the envelope as `structuredContent` |
| Embed launcher / WordPress plugin | The card URL for its agent | Card contents |
| Directive matching, Activity, Inbox | `callerKind` as a conversation fact | How the fact was derived |

Dependency direction: transports (MCP package, REST routes, cards, embed) depend on the OpenAPI contract; the contract depends on chat/routines domain types; domain never depends on a transport.

Shared ports, each published once through OpenAPI so the MCP package consumes them via its generated client (as it does today for `ask`):

| Port | Owner | Consumers |
|------|-------|-----------|
| **Agent tool descriptor** `{ toolName, description, inputSchema, routineLineageId }` | routines module (exposure helper) | catalog route, cards, MCP `tools/list` |
| **Routine invocation** `{ routine: { toolName, input } }` and its validator `validateRoutineInvocation(descriptor, input)` | routines module | the chat module's converse entry, called by both the MCP `ask` route and the REST `chat` route — neither transport validates on its own |
| **Agent reply envelope** | chat module (converse service) | MCP `ask`, REST `chat`, streaming terminal frame |
| **`callerKind`** | chat module (conversation fact) | directive matching, Activity, Inbox |

The MCP package never imports backend domain modules; it sees only the generated client types.

## User Scenarios & Testing

### User Story 1 — A calling agent gets a reply it can act on (Priority: P1)

A visiting agent asks a question or invokes a routine and receives, alongside the text, whether the answer was grounded, whether a human now owns the conversation, and what (if anything) is still needed from it.

**Why this priority**: Smallest change, largest payoff; every existing MCP and REST integration benefits immediately, and every later story returns this envelope.

**Independent Test**: Contract test on `POST /api/v1/mcp/converse/ask` and `POST /api/v1/agents/:id/chat` asserting the envelope fields for a grounded answer, an out-of-scope answer, a human-owned conversation, and a routine mid-collection.

**Acceptance Scenarios**:

1. **Given** a grounded question, **When** the caller asks, **Then** the reply carries `answerCoverage` with the same verdict the dashboard trace shows, and `citations[]` entries have a title and a resolvable URL or document id.
2. **Given** a question the corpus does not cover, **When** the caller asks, **Then** `answerCoverage.verdict` marks the miss and the text is whatever the agent's normal behaviour produces — no new hard-coded copy.
3. **Given** a conversation a human has taken over, **When** the caller sends another message, **Then** `ownership.state = "human_owned"` and the caller is told nothing was generated (`ownership.suppressed = true`), with the conversation id to return to.
4. **Given** an active routine that still needs a slot, **When** the reply is built, **Then** `routine.pendingInput[]` lists that slot's key, type, required flag, and description from the routine definition.
5. **Given** `stream: true` on the REST route, **When** the turn completes, **Then** the `done` frame carries the same envelope core as the non-streaming response.

---

### User Story 2 — Operator publishes a routine as a typed tool; a calling agent invokes it (Priority: P1)

An operator marks "Start a return" as exposed, names it `start_return`, and publishes. A visiting agent's `tools/list` now shows `ask_agent` plus `start_return(orderId, reason)`. Calling it starts that routine with the slots prefilled; confirmation steps, approvals, and handoff behave exactly as they would for a person.

**Why this priority**: This is what lets an agent *plan* against the business rather than guess phrasing. It is the product claim.

**Independent Test**: Deterministic eval: the same routine driven (a) by a human transcript and (b) by one tool call with the same slot values reaches the same step and the same skill effects; then a slot-missing call returns `pendingInput` without executing any skill.

**Acceptance Scenarios**:

1. **Given** a routine with declared slots `orderId: text (required)`, `reason: text`, **When** the operator enables exposure with tool name `start_return` and publishes, **Then** the agent's tool catalog contains `start_return` with a JSON Schema input of `{ orderId: string (required), reason?: string }` and the operator-authored description.
2. **Given** the tool is called with valid input, **When** the turn runs, **Then** the routine is admitted without the activation matcher, the slots are prefilled, slot-collection steps for filled slots are skipped, and the reply envelope reports `routine.status` and any `pendingInput`.
3. **Given** the tool is called with `orderId` missing or the wrong type, **When** validation runs, **Then** the call fails before any turn is recorded, with field-level errors, and no message is added to the conversation.
4. **Given** the routine has an approval step, **When** invoked by tool, **Then** the approval is created exactly as in chat and the envelope reports `routine.status = "waiting_for_approval"`.
5. **Given** the same routine has completed in the conversation, **When** the tool is called again, **Then** `activation.reentryMode` governs: `once_per_conversation` declines — the turn answers normally and the envelope still carries `routine: { toolName, name, status: "completed", pendingInput: [] }` so the caller learns why nothing started; `always` and `semantic` both re-admit with the new input and no model call, because an explicit tool call already answers the question the semantic judge asks of a chat message.
6. **Given** a different routine is active or suspended awaiting approval, **When** a tool is called, **Then** the invocation follows the existing interruption/approval rules; nothing tool-specific is added to those rules, and the envelope reports the routine that kept the turn plus `invocation.outcome = "not_started"` so the caller knows its call did not start anything.
7. **Given** an exposed routine is unpublished or its exposure disabled, **When** the next session starts, **Then** the tool is absent from the catalog and a call to it returns `routine_tool_unknown` — on both routes, resolved against the revision the conversation is pinned to, before any message is recorded.
8. **Given** an operator tries to change a tool name after first publish, **When** validating, **Then** publish is refused with `exposure_tool_name_changed`; the operator must disable that exposure and create a new one.
9. **Given** the REST audience, **When** `POST /agents/:id/chat` receives `{ routine: { toolName, input } }` instead of `message`, **Then** behaviour is identical to the MCP call and the response is the same envelope.
10. **Given** Ray, **When** the operator asks to "let agents start returns directly", **Then** Ray produces a `propose_routine_exposure` proposal the operator approves in the usual card.

---

### User Story 3 — A visiting agent finds the door from the customer's website (Priority: P2)

An agent given only `acme.com` locates Acme's support agent: what it is, what it can do, where the MCP endpoint is, and whether it can walk in or needs a credential.

**Why this priority**: Without discovery, US1–US2 serve only integrations someone configured by hand. Ships after them because the cards describe what those stories define.

**Independent Test**: Fetch the card URLs for a test agent and validate against the A2A agent-card schema and the MCP server-card draft; verify the embed snippet on a fixture page emits the link; verify a disabled agent returns 404.

**Acceptance Scenarios**:

1. **Given** an agent with a public id, **When** `GET /.well-known/agent-card/{publicId}.json` is fetched, **Then** the response is a valid A2A Agent Card: name, description, MCP endpoint URL, supported auth schemes (`none` when walk-in is on, `bearer` otherwise), and one `skills[]` entry per exposed routine (id = tool name, name, description).
2. **Given** the same agent, **When** `GET /.well-known/mcp/server-card/{publicId}.json` is fetched, **Then** the response follows SEP-2127 and points at the same endpoint; the same document is also served at the endpoint-relative path SEP-2127 reserves, `<mcp endpoint>/server-card`.
3. **Given** the website embed is installed, **When** the launcher bootstraps, **Then** the page carries a `<link>` to the agent card so a crawler-style agent finds it without executing the widget.
4. **Given** a WordPress site with the Radioso plugin, **When** an agent requests `https://acme.com/.well-known/agent-card.json`, **Then** it is redirected to the Radioso-hosted card for that site's agent.
5. **Given** cards are public, **When** fetched, **Then** they are cacheable (ETag, short max-age), rate-limited by source, and contain no secrets, workspace ids, or internal ids beyond the public id.

---

### User Story 4 — A visiting agent walks in without a minted credential (Priority: P2)

An operator turns on "Allow AI agents to connect without a credential" for a public-facing support agent. A visiting agent connects to the MCP endpoint with just the public id and starts a conversation, under the same abuse controls the widget gets.

**Why this priority**: Turns the platform from "integrations we approve" to "customer service anyone's agent can use". Gated behind an operator toggle, default off.

**Independent Test**: With the toggle on, an MCP client with no secret completes session exchange → `tools/list` → `ask_agent`; with it off, the exchange is refused; rapid repeated exchanges from one source are throttled.

**Acceptance Scenarios**:

1. **Given** `publicAgentAccessEnabled = true`, **When** a client exchanges a session using the public id and no secret, **Then** it receives a converse session bound to a new conversation with `sourceChannel = "mcp"` and `callerKind = "agent"`.
2. **Given** the toggle is off, **When** the same exchange is attempted, **Then** it is refused and the agent card advertises `bearer` only.
3. **Given** walk-in traffic, **When** one source exceeds the per-source or per-agent budget, **Then** further exchanges and turns are throttled through `AbuseControlService` and the throttle is recorded in the security event feed. The per-agent budget MUST be subdivided by source, so that one abusive caller cannot exhaust an agent's whole allowance and lock out every other caller.
4. **Given** a walk-in session, **When** the caller sends `signedIdentity` (the same HMAC visitor token the embed uses, bound to the MCP session id), **Then** the turn is a verified turn and `verifiedCustomerId` is set exactly as for the embed.
5. **Given** walk-in conversations, **When** the workspace's conversation quota is metered, **Then** they count like any other conversation.

---

### User Story 5 — A calling agent comes back after a human hands off (Priority: P2)

A routine escalates to a person. The calling agent, which cannot sit in a chat, checks back later and receives the human's reply.

**Why this priority**: Handoff is the third leg of "answer, act, hand off"; without resumption it is a dead end for agent callers.

**Independent Test**: Start a conversation via MCP, force a handoff, post a human reply from the Inbox, call `get_conversation_updates` with the cursor from the previous read — the human message is returned with `author = "human"`.

**Acceptance Scenarios**:

1. **Given** a converse session, **When** the caller invokes `get_conversation_updates({ cursor?, waitMs? })`, **Then** it receives messages after that cursor with author kind (`agent` | `human`), ids, timestamps, the current `ownership.state`, and the next cursor.
2. **Given** `waitMs` up to 25 000, **When** no message exists yet, **Then** the call long-polls on the conversation event bus and returns on the first new message or at the deadline with an empty list — never a hard error.
3. **Given** a credential-bound session whose credential is revoked, **When** updates are requested, **Then** the request is refused as any converse call would be.

---

### User Story 6 — The catalog describes the agent, and operators can treat agent callers differently (Priority: P3)

`ask_agent`'s description names the business and what it covers, and points to the typed tools. Operators see which conversations came from agents and can write directives that apply only to them.

**Why this priority**: Improves tool selection and gives operators a lever; not load-bearing for the door to work.

**Independent Test**: Snapshot the generated `ask_agent` description for a fixture agent with two exposed routines; unit-test that `callerKind` reaches directive matching as a visitor fact and that Activity filters by it.

**Acceptance Scenarios**:

1. **Given** an agent named "Acme Support" with operator description "orders, returns, billing" and exposed tools `check_order`, `start_return`, **When** the catalog is built, **Then** `ask_agent`'s description is composed from those fields and lists the tools to prefer for their tasks. It is assembled from configuration, not generated by an LLM at request time.
2. **Given** a conversation with `callerKind = "agent"`, **When** directives are matched, **Then** `callerKind` is available as a visitor-context fact so an operator can scope a directive to agent callers.
3. **Given** the Activity and Inbox views, **When** listing conversations, **Then** agent-originated conversations carry a visible marker and a filter.

---

### User Story 7 — The agent's developer has something to paste (Priority: P3)

The operator copies a ready-made "connect your agent" snippet (endpoint, card URL, sample configs for Claude, ChatGPT, Cursor, and the OpenAI Responses API) into their own help center. The docs portal serves `llms.txt` so an agent reading Radioso docs finds the right pages.

**Why this priority**: Adoption polish; depends on everything above being true.

**Independent Test**: The Channels → MCP card renders the snippet with the agent's real URLs; `GET /llms.txt` on the docs portal lists the connect guide.

**Acceptance Scenarios**:

1. **Given** the Channels → MCP card, **When** walk-in is on, **Then** a "Share with agent developers" block shows the endpoint, the card URL, and copyable client configs with no secret.
2. **Given** the docs portal, **When** `/llms.txt` is fetched, **Then** it lists the connect guide and the converse contract reference.

### Edge Cases

- Tool name collides with a reserved name (`ask_agent`, `get_conversation_updates`) or another exposed routine on the same agent → publish refused.
- A routine declares no slots → the tool has an empty object input schema; still valid and useful (`request_callback`).
- Slot type `date` / `email` → JSON Schema `string` with `format`; invalid formats fail validation before the turn.
- A routine's activation has a gate (`activation.gateRef` set) → exposure is refused in v1 (`exposure_requires_ungated_activation`). Gated routines stay reachable through `ask_agent`.
- Exposed routine is in the agent's draft revision only → absent from the catalog until published. The operator's Test Chat (`/assistant/chat`, `previewRoutineIds`) is a separate, unchanged surface and stays the way to try a draft; that plumbing is not reachable from the MCP or REST doors.
- Catalog changes while a session is open → the standalone MCP server keeps the catalog it pinned at session exchange, so `tools/list` is stable for that session; `GET /mcp/converse/tools` itself returns the agent's current published catalog. `notifications/tools/list_changed` is a follow-up.
- Walk-in session exchange on an agent whose workspace is over quota → refused with the same shape the embed receives.
- Card requested for an agent with walk-in off and no exposed routines → still served (name, description, `bearer`), because discovery of "needs a credential" is itself useful.
- Card requested for a deleted or unpublished agent → 404, no existence leak beyond that.
- `signedIdentity` on a walk-in turn with a mismatched session binding → the turn falls back to anonymous exactly as the embed does; no error.

## Functional Requirements

### Reply envelope

- **FR-001** `POST /api/v1/mcp/converse/ask` and `POST /api/v1/agents/:agentId/chat` MUST return the same **agent reply envelope core**: `conversationId`, `answerCoverage` (the existing assessment shape, always present — `not_recorded` when no assessment ran), `ownership` (`state`, `suppressed`; `ai_owned`/`false` when nothing else applies), `routine?` (`toolName?`, `name`, `status`, `pendingInput[]`), `invocation?` (only on a routine-invocation turn: `toolName`, `outcome` ∈ `started | reentered | declined | not_started | unknown_tool` — `not_started` when another routine was active or suspended and the existing interruption/approval rules kept the turn), `traceId?`. Citations use the existing `ChatCitation` shape (`documentId`, `chunkId`, `title`, `sourceUrl?`) on both routes.
- **FR-002** The core is additive on both routes; existing fields keep their names and shapes. MCP keeps `answer: { text, citations }`; REST keeps `answer: string` + `citations[]`. The shared contract is the core, not the answer field's layout.
- **FR-003** `routine.status` MUST be one of `active`, `waiting_for_input`, `waiting_for_approval`, `completed`, `abandoned`; `pendingInput[]` lists every declared required slot not yet filled plus the current step's unfilled optional slots, each with `key`, `type`, `required`, `description?` from the routine definition — so a calling agent can supply everything in one re-call.
- **FR-004** The REST SSE path MUST deliver the full envelope core in the terminal `done` frame. The MCP `ask` route is non-streaming (`stream: false` by contract) and returns the envelope in its single response.
- **FR-005** The MCP package MUST forward the envelope unchanged as `structuredContent` and keep `answer.text` as the summary content.

### Routine exposure

- **FR-010** A routine definition MAY carry `exposure: { enabled: boolean, toolName: string, description: string }`. `toolName` matches `^[a-z][a-z0-9_]{1,62}$`.
- **FR-011** The validator MUST refuse: duplicate `toolName` among enabled exposures within an agent; reserved names (every static tool the MCP surface serves, including the docs tools); `toolName` changed after the lineage has been published carrying that name, whether or not exposure was enabled at the time (`exposure_tool_name_changed`); exposure on a routine with an activation gate (`exposure_requires_ungated_activation`). Blank required values are refused at invocation time like missing ones.
- **FR-012** An **agent tool descriptor** MUST be derivable from an exposed, published routine: `toolName`, `description`, `inputSchema` (JSON Schema object built from declared slots: `text`→`string`, `number`→`number`, `boolean`→`boolean`, `email`→`string/format=email`, `date`→`string/format=date`; `required` from the slot), `routineLineageId`.
- **FR-013** `GET /api/v1/mcp/converse/tools` (session-bound) MUST return the agent's descriptors plus `agent: { name, description }`; `tools/list` on the MCP surface MUST be `ask_agent`, `get_conversation_updates`, and one tool per descriptor.
- **FR-014** `POST /api/v1/mcp/converse/ask` and `POST /agents/:id/chat` MUST accept a body of either `{ message }` or `{ routine: { toolName, input } }`. Input is validated against the descriptor's schema before any turn state is written — unknown fields, wrong types, bad formats, and any string value over the per-slot length cap fail with field-level errors and record nothing; the body as a whole is bounded like a chat message.
- **FR-015** A routine invocation MUST admit the named routine directly — bypassing the activation prefilter and ranked match — prefill its declared slots from `input` as routine variables, and otherwise run the existing turn: the runner's existing fast-forward (`isSatisfiedSlotCollectionStep` in `packages/conversation-engine/src/routineRunner.ts`) skips chat steps whose `collectsSlots` are all present; approvals, skills, directives, handoff, reentry, and interruption rules are unchanged.
- **FR-016** The invocation MUST be recorded as a user-authored message: `content` is the structural rendering `toolName {json}` with values verbatim (what a person would have typed; the LLM-visible history matches chat), and `inputMetadata: { method: "routine_invocation", routine: { toolName, input } }` so Activity and Inbox render it as a tool-call block. Operators see the values exactly as they see a typed message: an invocation *is* the caller's message, and the pushed-context redaction (which covers host-supplied identity facts, not what a caller chose to send) does not apply.
- **FR-017** The routine editor MUST offer exposure controls (toggle, tool name, description) and surface validator errors inline. Ray MUST offer `propose_routine_exposure` targeting a routine lineage with the same fields.

### Discovery

- **FR-020** `GET /.well-known/agent-card/{publicId}.json` MUST serve an A2A-conformant Agent Card for a published agent: `name`, `description` (a new operator-authored `publicDescription` on the agent — no such field exists today, and it is what US6's `ask_agent` formatter reads too), `url` (MCP endpoint), `securitySchemes` (`none` iff walk-in enabled; `bearer` always listed), `skills[]` from descriptors (`id = toolName`, `name`, `description`), `documentationUrl` (connect guide).
- **FR-021** The MCP server card MUST be served at the endpoint-relative path SEP-2127 reserves — `<mcp endpoint>/server-card` — for the same agent, and Radioso MUST serve a `publicId`-scoped canonical for it. Site-level indexes (`/.well-known/ai-catalog.json`, the `/.well-known/mcp/server-card.json` alias) belong on the **customer's own origin**, not on the shared API host, which cannot serve one tenant's card at an unscoped path; the embed `<link>` and the WordPress plugin (FR-023) are how a customer's origin points at its canonical. SEP-2127 is Final as the experimental extension `io.modelcontextprotocol/server-card`; its `$schema` URL is unpublished, so the card omits `$schema` until that resolves. Deployed cards in the wild also sit at `/.well-known/mcp/server-card.json`; serve that path as an alias so a client checking either location finds it.
- **FR-022** Cards MUST be public, unauthenticated, served with `ETag` and `Cache-Control: max-age=300`, rate-limited by source digest, and free of secrets and non-public identifiers.
- **FR-023** The embed launcher MUST emit a `<link>` to the agent card during bootstrap; the WordPress plugin MUST answer `/.well-known/agent-card.json` on the site with a redirect to the Radioso-hosted card.
- **FR-024** `publicId` MUST be a dedicated per-agent public identifier — not the embed launch token, which is a secret in page HTML — with ≥ 128 bits of entropy, minted when discovery or walk-in is first enabled and rotatable from Channels → MCP the way the embed token rotates. It is both the discovery key and (with FR-030) the walk-in access key, so it must be separable from the embed's own key and from the agent's internal id. Unknown, unpublished, and deleted ids all answer 404 identically.

### Walk-in access

- **FR-030** Agents MUST carry `publicAgentAccessEnabled` (default `false`), editable from Channels → MCP and proposable by Ray under the existing channel-settings proposal.
- **FR-031** When enabled, the MCP session exchange MUST accept the public id with no secret and issue a session bound to a fresh conversation with `sourceChannel = "mcp"` (and `callerKind = "agent"` once FR-050 lands in US6 — this story does not depend on it); when disabled the exchange MUST be refused without revealing whether the agent exists beyond what the card already says.
- **FR-031** *(alternative, decide at plan time)* The walk-in exchange may instead be modelled as OAuth 2.1 dynamic client registration (RFC 7591) with an anonymous grant on the converse surface, reusing the operator-MCP authorization server. Heavier, but then any OAuth-capable MCP client walks in with no Radioso-specific step and `securitySchemes` in the card lists `oauth2` rather than `none`. The lighter public-id exchange is the default.
- **FR-031a** Walk-in sessions MUST carry an absolute lifetime — the same one a public browser session carries, which is stricter than an idle window because a caller cannot extend it by staying busy — and MUST be invalidated when `publicAgentAccessEnabled` is turned off or the public id is rotated: every converse request re-checks the flag and the id, mirroring how credential-bound sessions re-check their credential.
- **FR-032** Walk-in exchanges and turns MUST pass through `AbuseControlService` on two keys: per source digest (as anonymous chat does) and per agent (new conversations per hour, default conservative, operator-adjustable from Channels → MCP). The per-agent budget is what stops one looping caller from consuming the workspace's conversation allowance; when hit, walk-in exchanges are refused with HTTP 429, a `Retry-After` header, and the IETF `RateLimit-*` headers (draft-ietf-httpapi-ratelimit-headers) so a calling agent can back off correctly; human channels are unaffected.
- **FR-033** Converse `ask` MUST accept `signedIdentity`, verified with the MCP session's `publicSessionId` as the bound session. An MCP session has no client-facing bootstrap and therefore no origin: the verifier MUST take the bound origin as optional and, when the caller is an MCP session, check only the session binding, the issuance window, and the single-use nonce. The signed payload keeps `origin` as a required field carrying a caller-declared value that is recorded, not trusted. Verification produces the same `verifiedCustomerId` / `verifiedIdentity` as the embed path.
- **FR-034** Walk-in conversations MUST be metered like every other conversation through the conversation-metering path (#1246): same quota, same cost, which the existing `"mcp"` source channel already gives them. There is no separate bucket for agent callers; usage rows carry `callerKind` once FR-050 lands so the split is observable. Protection against a runaway caller is the per-agent walk-in rate budget in FR-032, not the quota.

### Resumption

- **FR-040** `GET /api/v1/mcp/converse/messages?cursor=<opaque>&waitMs=<0..25000>` (session-bound) MUST return messages after the cursor with `id`, `author` (`agent` | `human`), `createdAt`, `text`, the current `ownership.state`, and the next cursor. The cursor is opaque and comes from a prior response (history already pages by keyset, which a bare message id cannot seek against); an absent cursor returns the conversation's most recent page, which is the whole conversation whenever it is shorter than one page. With `waitMs` it MUST wait for a new message, and MUST NOT rely on the in-process event bus alone — the API runs multiple instances, so a bus subscription is raced against a bounded re-poll.
- **FR-041** The MCP surface MUST expose it as `get_conversation_updates`.

### Caller kind and catalog description

- **FR-050** Conversations MUST record `callerKind` (`human` | `agent`), set by the channel: `mcp` and `agent_api` → `agent`; embed, anonymous link, authenticated chat, Slack → `human`.
- **FR-051** `callerKind` MUST be available to directive matching as a visitor-context fact and shown/filterable in Activity and Inbox. Copilot coverage: the filter is a read-only view control and is recorded as a coverage-map exclusion; Ray's existing conversation probes gain `callerKind` in their output.
- **FR-052** The `ask_agent` description MUST be composed from the agent's name, operator description, and the names of exposed tools, by a pure formatter — not by an LLM and not hard-coded per agent.

### Docs and contract

- **FR-053** The Channels → MCP "Share with agent developers" block (US7) is a read-only rendering of existing settings and is recorded as a coverage-map exclusion; the settings it renders are already proposable through FR-017 and FR-030.
- **FR-060** The connect guide, converse contract reference, exposure authoring guide, and walk-in security notes MUST ship with the change; `docs/mcp-client-setup.md` and `docs/operator-mcp.md` updated; the docs portal serves `/llms.txt`; the product-docs corpus is re-synced.
- **FR-061** OpenAPI, the TypeScript SDK snapshot, and the MCP package's generated client MUST be regenerated in the same change. No worker payload or queue contract changes: every new path is synchronous request/response on the API process; the document worker and AMQP queues are not on any of them, and long-poll waits use the in-process conversation event bus.

## Non-goals

- **Full A2A protocol** (task lifecycle, streaming, push notifications). Only the Agent Card is adopted; the transport stays MCP + REST.
- **WebMCP / in-page tool exposure.** Tracked separately once the W3C work stabilises.
- **Structured tool outputs.** v1 returns the envelope; mapping routine variables to a JSON `outputSchema` is a follow-up.
- **Per-skill tools.** Routines are the unit of operator control; skills stay behind them.
- **Walk-in on the REST audience.** REST keeps credentials; walk-in is MCP only.
- **`notifications/tools/list_changed`** mid-session.
- **Operator MCP** changes; Ray's surface is untouched except the new proposal.
- **A per-business hosted "connect" page.** v1 gives operators a snippet to publish themselves.

## Key entities

- **Agent reply envelope** — FR-001. One schema, two routes, forwarded verbatim by MCP.
- **Routine exposure** — `{ enabled, toolName, description }` on a routine definition; `toolName` frozen after first published use.
- **Agent tool descriptor** — `{ toolName, description, inputSchema, routineLineageId }`; the shared port between routines and every transport; published in OpenAPI.
- **Routine invocation** — turn input `{ routine: { toolName, input } }`; recorded as a structured user message.
- **Agent card / server card** — public, cacheable JSON derived from agent config + descriptors + walk-in flag.
- **Public agent id** — FR-024.
- **`publicAgentAccessEnabled`** — per-agent flag; walk-in gate.
- **`callerKind`** — per-conversation fact, `human` | `agent`.

## Assumptions

- Declared slots (`routineSlotSchema`) are the complete input contract for a routine; steps that reference undeclared slots already fail validation, so the descriptor is derivable without inference.
- The runner's `isSatisfiedSlotCollectionStep` fast-forward is sufficient to skip collection steps for prefilled slots once the invocation sets them as routine variables; no new step kind is needed. (Compiler auto-gating is a different mechanism — it shapes how chat *captures* a slot — and is not relied on here.)
- The MCP package can build a per-session tool list; it already holds per-session state.
- Existing REST callers tolerate additive response fields.
- Discovery paths follow the MCP server-card draft's multi-server shape (`/.well-known/mcp-server-card/{name}`) and A2A's card shape; if the specs converge on different paths before ship, the paths change, not the content.
- The WordPress plugin is the only component on the customer's domain, hence the redirect lives there; other CMSs use the embed `<link>` or a manual redirect documented in the connect guide.

## Observability

- Metrics: converse turns by input kind (`message` | `routine_invocation`) and by `callerKind`; routine invocations by outcome (`started`, `validation_failed`, `unknown_tool`, `reentry`); walk-in exchanges by outcome (`issued`, `disabled`, `throttled`); card requests by kind and cache hit. No `toolName` or agent id labels.
- Logs: validation failures carry field keys only, never values; walk-in refusals carry the source digest and agent id at `info`; card 404s at `debug`.
- Audit events: exposure enabled/disabled/renamed (refused), `publicAgentAccessEnabled` changed, with actor — through the existing agent-revision and channel-settings audit paths.
- Spans: the routine-invocation turn gets the same turn spine as a message turn plus a `routine.invocation` attribute set (`toolName`, `slotCount`, `prefilledCount`); long-poll waits are not spans.
- Nothing new leaks prompts, slot values, or identity attributes.

## Success criteria

- **SC-001** On a walk-in-enabled agent, an MCP client with no prior configuration completes discover (card) → connect → `tools/list` → one routine call → envelope with `routine.status`, with zero operator steps, in the e2e suite.
- **SC-002** In the deterministic eval suite, a routine driven by tool invocation with all required slots reaches the same step and the same skill effects as the equivalent chat transcript for 100% of fixture routines.
- **SC-003** *(follow-up after US6's description formatter; not part of slice 1)* A new `converse-tool-selection` eval suite, shaped like `tests/unit/operatorCopilot/copilot-eval-suite.test.ts` (deterministic half in CI, live half under `evals:*` with a committed baseline), shows a calling model given a task against a fixture agent exposing 5–10 tools selects the intended tool in ≥ 90% of cases.
- **SC-004** 100% of converse and REST chat responses carry `answerCoverage` and `ownership` (contract test).
- **SC-005** Card endpoints serve at p95 < 50 ms from cache and are validated against the A2A card schema in CI.
- **SC-006** After a forced handoff and a human reply, `get_conversation_updates` returns the reply on the first long-poll in the e2e suite.

## Open questions

- Whether `callerKind` should also be settable by the embed host (a site that runs its own agent inside the widget) — out of scope unless a customer asks.
- *(resolved 2026-09-22)* Server-card path: SEP-2127 is Final as an experimental extension reserving `<endpoint>/server-card`, with site-level discovery in `/.well-known/ai-catalog.json`; deployed cards also use `/.well-known/mcp/server-card.json`. FR-021 serves the reserved path, the catalog, and that alias.
- Walk-in session exchange: public-id + flag check (default) vs OAuth dynamic client registration (RFC 7591). The public-id path reuses the existing session-exchange shape; DCR would let any OAuth-capable MCP client walk in with no Radioso-specific step but duplicates the operator surface's authorization server for an anonymous principal. Decide at plan time.
