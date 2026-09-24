# Implementation Plan: Agent-consumable service surface — US6 (caller kind) and US7 (connect snippet)

Issue #1307. Spec: `spec.md` US6 (FR-050..FR-053), US7 (FR-060..FR-062), plus the two slice-2
deferrals that point here — `FR-031`'s `callerKind = "agent"` on a walk-in conversation and
`FR-034`'s `callerKind` on usage rows.

Two PRs. US6 first: it is smaller, and `SC-003`'s `converse-tool-selection` eval suite and both
deferrals wait on it. US7 depends on nothing in US6 and can follow.

## What the code says today (verified; corrects the spec where they differ)

- **`sourceChannel` is untyped.** The column is a nullable `TEXT` with no `CHECK` constraint
  (`007_connector_config.sql`), typed `string | null` in the generated Kysely schema, and written from
  string literals at each call site — `"anonymous"`, `"website_embed"`, `"authenticated_chat"`,
  `"slack"`, `"whatsapp"`, `"mcp"`, `"agent_api"`, `"workbench_replay"`, `"operator_copilot_probe"`.
  There is no exhaustive union to switch on, so any mapping from channel to caller kind is total by
  construction and needs a stated default.
- **One repository owns conversation creation**, `backend/src/db/repositories/conversationRepository.ts`,
  with three inserts (`getOrCreateByAnonymousSession:301`, `create:317`,
  `createWithInitialAssistantMessage:377`) all fed by `CreateConversationInput`. FR-050's "set by the
  channel" therefore has a single seam, not one per channel.
- **`conversationSource.ts` already owns channel meaning.** `isOperatorTestSourceChannel`,
  `OPERATOR_TEST_SOURCE_CHANNELS`, and `ConversationSourceScope` are the existing precedent for
  "what does this source channel imply"; caller kind is the same kind of fact and belongs beside them.
- **The spec's "visitor-context fact" is right, but the obvious seam is wrong.** `visitorMatchContext`
  returns `projectContextForMatching(...)`, which is *operator-defined context variables only*. The
  tempting alternative — `DirectiveSteerInput.turnContext` — would be a defect: **two surfaces classify
  contextual directives**, and when a fused turn plan exists `planAwareDirectiveClassifications` uses
  the planner's classifications and never calls the matcher, so wiring only `turnContext` leaves the
  feature dead on normal turns. Both consumers take `visitorContext?: Record<string, unknown>`
  (`conversationProcessTurnInput.ts:126`, `turnPlanService.ts:74`) and the planner JSON-serializes it
  into `turn-planning-directives.md` (`turnPlanService.ts:109`), so one reserved key in that record
  reaches both paths with no type change.
- **There is no per-turn usage row.** Usage aggregates into EE counter tables
  (`ee_usage_limit_unit_kind_counters`, `ee_usage_limit_conversation_replies`). FR-034's "usage rows
  carry `callerKind`" cannot be satisfied literally; the honest reading is a new dimension on the
  per-kind counter, fed from the same `chatAnswerUsageKind(sourceChannel)` seam
  (`chatService.ts:171`) that already derives billing weight from the channel.
- **`ask_agent`'s description is a hardcoded string** (`packages/radioso-mcp-server/src/tools/converseTools.ts:11`).
  `AgentRecord.publicDescription` exists (`agents/domain.ts:257`, max 500 chars) and
  `AgentToolCatalogPort.load` already returns `{ agent: { name, description }, tools }` — FR-052's
  exact inputs. Slice 1's plan named this formatter as a future consumer of `AgentToolDescriptor`.
- **The docs portal has no `/llms.txt`.** `app/robots.ts` and `app/sitemap.ts` are the route convention
  to follow.

## Design answers (the three questions)

**What does each part know?**

- `backend/src/shared/domain/conversationSource.ts`: that a source channel implies a caller kind, and
  which channels are agent-driven. Not: conversations, directives, metering, HTTP.
- `conversationRepository.ts`: that a stored conversation carries the kind decided at creation. It does
  not decide it — it calls the domain function, so the rule has one home and the column cannot drift
  from it per call site.
- `chat/services/visitorMatchContext.ts`: that caller kind is part of "who am I talking to" for this
  turn, alongside the redacted variable projection. Not: how either consumer judges a directive.
- `ee/.../usageLimits`: that answers split by caller kind. Not: which channels are agents.
- History routes / Activity / Inbox: that `callerKind` is a filterable column. Not: how it is derived.
- MCP package: nothing new. The composed `ask_agent` description arrives as catalog data, because the
  package consumes generated OpenAPI types only and must not learn what an agent description is made of.

**What ports, to whom?**

- `CallerKind = "human" | "agent"` and `callerKindForSourceChannel(sourceChannel: string | null | undefined): CallerKind`
  — `backend/src/shared/domain/conversationSource.ts`. Total, defaulting to `"human"`: a channel nobody
  has classified is a person until someone says otherwise, which is the safe read for a lever that
  scopes agent-only behaviour.
- `AGENT_SOURCE_CHANNELS = ["mcp", "agent_api"] as const` beside it, mirroring `OPERATOR_TEST_SOURCE_CHANNELS`.
- `CreateConversationInput.callerKind?: CallerKind` is **not** added. The repository derives it from
  `sourceChannel` it already receives; an optional input would let a caller contradict its own channel.
- `visitorMatchContext(session)` returns the projection plus one reserved key. Reserved keys are
  prefixed so an operator-named context variable cannot collide or shadow: `radioso_caller_kind`.
- `chatAnswerUsageKind` is unchanged; caller kind travels as a separate dimension on the reserve call,
  because it is orthogonal to what is being metered.
- `composeAskAgentDescription({ agent: { name, description }, tools }): string` — a pure formatter in
  `backend/src/modules/routines/exposure/`, beside `agentToolDescriptor.ts`, published on the catalog
  response.

**Dependency direction.** `shared/domain/conversationSource` ← repository, chat, history, EE metering.
Nothing depends back on it. The formatter sits in `routines/exposure`, which already owns descriptor
derivation; the MCP package stays a consumer of generated types.

## Slices

### US6-A — the fact (FR-050, FR-031's deferral)

Migration `197_conversation_caller_kind.sql`: `caller_kind TEXT NOT NULL DEFAULT 'human'` on
`conversations`, backfilled from `source_channel` with the same rule as the domain function. **No
index, deliberately.** The only query filtering on the column is the Activity/Inbox filter, whose
interface is US6-C, and a non-concurrent `CREATE INDEX` on `conversations` would block live chat
writes for its scan — migrations run at API boot while the previous revision serves, one transaction
per file, so it cannot be built `CONCURRENTLY`. Taking that lock for an index no shipped query reads
buys nothing; it belongs with the surface that reads it, sized against real traffic. Without it this
migration needs no coordinated deploy window at all. `db:types` **and** `db:schema` both re-run. Domain function
+ repository writes + `callerKind` on the conversation domain record and its API mappings. Ray's
`conversation_transcript` and `conversation_history_search` outputs gain the field.

### US6-B — the lever (FR-051 matching) — as built

`visitorMatchContext` gains the reserved key `radioso_caller_kind`, applied *after* the projection so
a workspace context variable of the same name cannot shadow the fact. Both consumers read that one
projection, so the matcher and the fused planner get it together or not at all.

**Behaviour change, deliberate.** The matcher used to omit `visitorContext` entirely when no context
variable resolved; it is now always sent, carrying at least the caller kind. A key that is only
sometimes present is not something an operator can write a condition against, and "absent means
human" is not a rule a prose condition can rely on. Two existing matcher assertions were updated to
state the new shape rather than loosened.

### FR-034 metering split — not done, needs a decision

The spec says "usage rows carry `callerKind` so the split is observable". There are no per-turn usage
rows: usage aggregates into EE counter tables (`ee_usage_limit_unit_kind_counters`,
`ee_usage_limit_conversation_replies`), and `usageLimitService` emits no metrics at all. So there are
two different changes hiding behind one sentence, and they answer to different owners:

- a **counter dimension** in EE — a schema change to billing-adjacent tables, which fragments the
  numbers an invoice is reconciled against;
- a **metric label** — observability only, but there is no answer-counting metric to label yet, and
  `converse_turns_total` is the wrong host because both doors that emit it are agent callers, so the
  label would be constant.

The spec's own Observability section asks for "converse turns ... by `callerKind`", which reads as
the second. Left for a decision rather than guessed at; the fact it needs is now stored and queryable
either way.

### US6-C — the view (FR-051 Activity/Inbox) — backend done, frontend open

Backend: `callerKind` on `historyItemsListQuerySchema`, filtered in `historyItemsRepository` on both
the row CTE and the COUNT subquery (a filter on only one makes a page claim more rows than it can
show), documented on the `/history` path, and joined to `hasChatOnlyFilter` — a contact request has
no conversation behind it and therefore no caller, so asking for one kind cannot be answered by
returning contacts too.

Frontend remains: the filter control on the Activity toolbar and the Inbox All-lens toolbar (both
feed `buildConversationSearchParams` in `frontend/lib/conversation-filters.ts`, so one addition
serves both), a caller chip on the conversation row modelled on `TYPE_CHIP_META`/`TypeChip` in
`inbox-queue-row.tsx`, and Playwright coverage extending `assistant-history.spec.ts`. The generated
frontend types already carry `callerKind`. That is what makes the hand-written fixtures incomplete
rather than what makes them fine: eight of them construct a conversation summary or detail
literally, and the CI Frontend job typechecks them through `pretest:e2e`. Run
`pnpm exec tsc --noEmit -p frontend/tsconfig.json` before assuming a generated-type change is
frontend-neutral.

The Inbox **Needs-you** lens is a different projection: `InboxItem` carries no `sourceChannel` or
`callerKind`, so filtering that lens needs the field added to the needs-attention read as well. That
is its own slice, not part of this one.

### US7 — not started

See the slice above for what it covers.

### US6-D — the catalog description (FR-052)

The pure formatter, snapshot-tested for a fixture agent with two exposed routines, surfaced on the
catalog response and consumed in place of the static `ask_agent` string. `SC-003`'s eval suite is
explicitly *not* in scope — the spec calls it a follow-up, and this slice is what unblocks it.

### US7 — connect snippet (second PR, FR-053, FR-060..FR-062)

Channels → MCP "Share with agent developers" block; docs-portal `/llms.txt`; the connect guide and
converse contract reference; OpenAPI, SDK snapshot, and MCP generated client regenerated; product-docs
corpus re-synced. Not started.

## Contract-change review

US6-A changes no cross-service contract: no worker payload, no queue, no MCP contract. US6-D adds a
field to the catalog response, so OpenAPI and the TypeScript SDK snapshot regenerate in that slice
(`cd typescript-sdk && pnpm run sync`). US7 carries FR-061's full regeneration.

## Verification per slice

Root `pnpm run lint` and `lint:dead-code:ci`, plus backend `test:unit` and `test:contract`, on every
slice. US6-A additionally needs both database snapshots committed, or `ci:local` fails on the missed
one. Frontend slices use Playwright for the visible filter behaviour, not markup assertions.
