# A2A module

The A2A module lets a client built on an A2A v1.0 SDK use a published agent the card advertises.
It serves `POST /a2a/{publicId}`, A2A's JSON-RPC binding, with four methods:

- `SendMessage` runs one converse turn and returns a `Message` or a `Task`.
- `GetTask`, `ListTasks` and `CancelTask` read the tasks those turns left.

It runs the same converse turn MCP's `ask` runs, on the `a2a` source channel, and records the
little bookkeeping A2A needs beside the conversation. The normative spec is
`specs/1731-a2a-protocol-binding/spec.md`.

Start at `routes.ts` for the request pipeline, `services/a2aService.ts` for the four methods
behind one admission step, and `domain/taskState.ts` for the precedence table that decides every
task state.

## Boundaries

The module knows three things:

- the A2A v1.0 wire shapes (ProtoJSON enum names, parts with no `kind`, `{ task }` or `{ message }`
  results) and the JSON-RPC errors;
- the context tokens callers hold;
- the task and receipt records.

It reaches the rest of the backend through ports:

- chat's `AgentConverseService` runs turns, and its reply envelope describes them;
- settings' `AgentConversePrincipalPort` opens and re-verifies contexts;
- `contracts/ports.ts` declares the conversation reads (`A2aTranscriptPort`), the agent lookup
  (`A2aAgentDirectory`), the sealer, and the two stores.

Application composition implements those ports and hands in the HTTP limits. It does this in
`app/composition/a2a.ts` and `a2aTranscript.ts`, and mounts the router at the agent discovery
module's `A2A_ENDPOINT_MOUNT_PATH` from `builtIn/a2aModule.ts`. Routines, MCP and the card's JSON
stay on the other side of those ports. Only composition imports this module, through `public.ts`.

## A request, in order

`routes.ts` handles a request in this order:

1. It reads and validates the call before it looks anything up. These checks are pure and run
   on every request:
   - the content type;
   - the JSON-RPC envelope (a batch is -32600);
   - `A2A-Version: 1.0`, from the header or, without one, the `A2A-Version` query parameter (no
     version means 0.3, so it is -32009);
   - the method (streaming and the extended card are -32004, push configs -32003, anything
     else -32601);
   - the params (`domain/requestParams.ts`).

   Only text parts are accepted, and anything else is -32005. The joined text is bounded by the
   chat message limit.
2. It spends the pre-auth source budget. Turns spend MCP converse's; task reads spend the
   update-read source budget.
3. It resolves the agent. An unknown id, a card switched off, an unpublished agent or a deleted
   one answers the card's own 404.
4. It spends the walk-in conversation budget, which MCP spends too. Only a `SendMessage` that
   names no context or task and presents no bearer spends it (`a2aWalkInPublicId`).
5. It admits the caller (`services/a2aAccess.ts`):
   - With no context, it opens one through the walk-in door or an `Authorization: Bearer`
     converse grant.
   - With a context or a task, it re-verifies the sealed origin under the credential presented
     now.
6. It spends the per-caller budgets, keyed exactly as MCP's: by grant, or by walk-in public id
   and source.
7. It runs the method.

JSON-RPC errors answer HTTP 200, and -32603 answers 500. These answer at the HTTP level through
the shared error handler:

- a refused opening (401 or 403, with the refusal `code`);
- a missing agent (404);
- a spent budget (429 with `Retry-After` and `RateLimit-*`).

A body that does not parse is refused by the shared body reader before the router runs. On this
path, the mount's error handler (`createA2aBodyErrorHandler`) answers it as -32700.

Every error carries one `google.rpc.ErrorInfo`. A2A's own errors use domain `a2a-protocol.org`;
Radioso's reasons use `radioso.ai`:

- `CONTEXT_NOT_FOUND` (-32602);
- `TURN_SUPERSEDED`, `TURN_IN_PROGRESS` and `USAGE_LIMIT_EXCEEDED` (-32000).

An error's metadata is always empty.

## Contexts

A context is one conversation. Its id is the settings `AgentConverseOpening`, sealed by
`infra/contextSealer.ts`:

- `domain/contextClaims.ts` encodes the opening (workspace, agent, public session id, origin,
  and a walk-in context's absolute end).
- The deployment's field encryption keys (`CONNECTOR_ENCRYPTION_KEY`) encrypt and authenticate
  it.
- It travels as base64url.

Nothing about a context is stored, and every request re-verifies its origin. Rotating the public
id, closing the walk-in door, or revoking the grant ends the context on its next call.

A grant context continues only for a caller presenting the same grant. A context, or a task,
that fails any check answers exactly like one this server never issued: unreadable, another
agent's, expired, revoked, or another caller's. With no encryption key configured, opening a
context answers 503 and no token opens.

## Tasks

A task record (`a2a_tasks`, migration `253_a2a_tasks.sql`) holds references and state only. It
holds no message text:

- the conversation, and the context id the caller holds;
- the routine run it follows;
- the opening message, the caller's last message, and the cursor with the message it sits on;
- the status and artifact message ids, and the last turn's envelope core;
- the state, reason and state time, and a version;
- `human_stretch`: set once a person owns the thread or writes in it while the task is open, and
  never cleared. `reason` says only what last moved the task, which a read rewrites.

A partial unique index keeps one open task per conversation. A task id is 128 random bits.

**After a turn.** `decideTaskAfterTurn` applies rows 1–10 of the precedence table to the turn's
ownership, routine status and invocation outcome, and to two facts `AgentConverseTurnResult`
carries beside the reply: the run the reported routine names (`routineExecutionId`), and the run
still active once the turn finished (`activeRoutineExecutionId`, read from the routine store, so an
expired run is none). Three readings are made explicit in the code:

- Row 7 (declined) is checked before row 8 (completed), because a declined call reports its
  routine as `completed`.
- Row 6 replaces only a task that follows a routine. A stretch of human ownership takes on the
  routine that starts after the hand-back.
- A routine that yields to an off-topic message reports nothing, but its run is still active: the
  task stays `input_required` on the turn's reply, keeps the routine report it had, and rows 9
  and 10 do not apply. Row 10 needs no run active after the turn.

The turn names its own messages: `requestMessageId` and `replyMessageId` on the turn result are the
caller message and reply a task records, a receipt replays, and the status message and artifact
point at. A read after the turn only finds where the caller's view now ends, and a person's replies
after the turn's own message.

A plain answer, with no task open and nothing pending, is a `Message` and writes no record.

**Unseen human messages.** When a turn finds a person's messages after the caller's previous
message, from the conversation's latest page, the task it opens starts at the first of them. So
its history carries what the caller has not seen.

**The cursor.** Each task's cursor sits just after the last message its caller has been shown.
`GetTask` and `ListTasks` read past it (rows 1 and 3, `decideTaskOnRead`), page by page to the end
of the conversation (`services/transcriptReads.ts`; past ten pages a read takes the latest page). A
reply found there makes the task `input_required` on the newest such reply, and the cursor moves
past it. The read changes only `ownership` in the stored envelope; the routine report and citations
the last turn recorded stay. A second read with nothing new answers the same, until the caller's
next turn.

**Concurrency.** Every task write compares and sets on the version (`A2aTaskStore.commit`, in one
transaction):

- A read that loses answers the task as the turn left it.
- A turn that loses re-decides against the task as it now stands, and writes again.

**History.** History is the task's own messages: the range from its opening message through the
message its cursor sits on. Caller messages are `ROLE_USER`, and the agent's and people's
messages are `ROLE_AGENT`.

**What callers cannot do.** `CancelTask` answers -32002 for every task a caller can reach.
`SendMessage` to a terminal task is -32004. `ListTasks` with no `contextId` lists nothing.

## Idempotency

`SendMessage` is idempotent on `(conversation, messageId)` (FR-038), through `a2a_message_receipts`:

- A send claims a receipt keyed by a digest of the caller's id, under a random claim token.
- A retry while the claim is in flight answers `TURN_IN_PROGRESS`.
- A finished send stores what replays it: the reply's message id and envelope core, or the task's
  id. A retry returns that without a turn, even when the task has since finished.
- A failed send releases its claim; a release that fails logs at `warn` with a conversation digest.
  A claim left by a dead process is taken over after ten minutes, under the new send's token.
- Completing and releasing match the token, so a slow send whose claim was taken over changes
  nothing.

A context's first send has no conversation to key a receipt by, and its retry opens a new
context anyway.

## The converse extension

A client activates the extension by naming `A2A_CONVERSE_EXTENSION_URI` in `A2A-Extensions`. The
server echoes the activated list in the response header. While the extension is active, these
carry the reply envelope core and `author` (`agent` or `human`) under `metadata[<uri>]`, and list
the URI in their `extensions` field:

- every `Message`;
- every task status message;
- every artifact.

The core is `answerCoverage`, `ownership`, `routine` with `pendingInput`, `invocation`, and
`citations`. A task's `metadata[<uri>].reason` names the row that set its state.

Status messages and artifacts only ever carry text a turn produced or a person wrote.

## Observability and data

**Metrics** (no agent, context, task or tool labels):

- `a2a_requests_total{method, outcome}`, where method is a served method or `other`, and outcome is
  `ok`, an error reason, or for an answer the shared error handler gave, `not_found`, `refused`,
  `rate_limited`, `payload_too_large`, `client_error` or `error`;
- `a2a_task_transitions_total{to_state}`.

**Logs and spans:**

- A refusal logs at `info` with the source digest, the agent id, and a task id digest.
- A receipt release that fails logs at `warn` with a conversation digest and the error's class.
- `SendMessage` runs in an `a2a.send_message` span (`a2a.method`, `a2a.task_state`), the parent
  of the turn's spans.
- Walk-in openings count and log through the walk-in observer MCP uses.

**Retention.** Both tables cascade with their conversation and workspace.
`app/composition/conversationRetention.ts` binds two rules:

- `A2aTaskRetention` removes tasks of expired walk-in contexts, and tasks 90 days after they
  finished.
- `A2aMessageReceiptRetention` removes receipts of expired walk-in contexts, and any receipt
  after 90 days.

**Data-subject export.** `A2aTaskExporter` writes the `a2a_tasks` section: state, reason and
times, without task ids.

## Focused checks

- `cd backend && pnpm exec vitest run tests/unit/a2a tests/contract/a2a-binding.contract.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/a2a-binding.integration.test.ts tests/integration/a2a-tasks.integration.test.ts tests/integration/a2a-sdk-client.integration.test.ts`
- `cd backend && pnpm exec vitest run tests/integration/a2a-task-store.integration.test.ts tests/integration/a2a-tasks-postgres.integration.test.ts` (Postgres)
