# Feature Specification: Typed attributes the AI fills, operators see and routines write

**Branch**: `feat/typed-attributes-1884` (PR 1a)
**Created**: 2026-11-21
**Status**: Approved (product owner review, 2026-11-21, D9 and D13 confirmed); see "Review outcome" below
**Issues**: #1884
**Input**: An operator cannot label conversations with typed facts the agent fills in, see those labels in the Inbox, or filter by them. Extend context variables with typed values, more writers, a record of who wrote a value, and a scope every channel has.

Citations are `path:line` from the repo root, read on `main` at `6a1dadbba0`.

## Decisions at a glance

| # | Decision | Section |
|---|----------|---------|
| D1 | Extend context variables. No `attributes` module, table or API namespace. The dashboard and docs say "Attributes" from the first PR that adds UI (1a); the API keeps `/context-variables` | 1, 12 |
| D2 | Definitions and option lists are workspace-level and not revisioned. Whether an agent classifies a variable, and its surfacing, follow draft/publish through the existing enablement snapshot | 2 |
| D3 | New `conversation` scope keyed by `conversations.id` | 3 |
| D4 | Types: `enum` with described options first, then `boolean`, `number`, `date`. Options have an immutable key and are archived, never deleted | 4 |
| D5 | Every value records its last writer: `api`, `operator`, `routine` or `classifier`, plus a reference. No history table | 5 |
| D6 | The classifier writes only over an empty or classifier-written value. Every other writer is last-writer-wins. A human value for the conversation, session or customer holds the variable; an agent or workspace value is a default the classifier's conversation value outranks | 5 |
| D7 | Classification is a per-conversation `rerun` background job after each committed turn. It is not built on the facet job | 6 |
| D8 | A handoff notice classifies inline before it is sent, inside the notice's own dispatch job, bounded at 10 s. A failed or timed-out classification never holds the notice | 7 |
| D9 | `handoff.requested` keeps its payload and stays in the turn's transaction. Attributes reach automations through `context_value.changed` and the notice webhook | 7, 11 |
| D10 | Routine write-back is authored on the slot (`saveTo`), validated, and written when the routine ends, in the turn's transaction | 9 |
| D11 | Person-level values key on the verified customer id, or on the WhatsApp number through a new `whatsapp_contact` scope type. No cross-channel merging. Email sender addresses are not a person key | 10 |
| D12 | 50 options per enum, 8 classified variables per agent. No backfill. No classification into a `sensitive` variable | 4, 6, 13 |
| D13 | Classified values stay out of the answer prompt by default. The default surfacing is `on_reference`, not `operator_only`: see the correction in "Review outcome" | 8 |
| D14 | The takeover permission sets or resets a value from the Inbox | 11 |
| D15 | Logs, metrics and spans never carry a value, including an enum key | 13 |

## Review outcome

The design was accepted with three changes, all applied here.

- **Slicing proves operator-visible value.** A directive's prose condition can already judge "asks about billing" from the message, so "steers the next turn" was the weakest proof. Slice 1 now ends with an Attributes block on the conversation and an Inbox filter (section 14).
- **Handoffs classify before the notice.** Many handoffs happen on turn 1 or 2, before an after-turn job has run (section 7).
- **The WhatsApp number is a person key** (section 10).

Three items the design left unverified are now closed:

- `resolveForEnablements`, the revision-pinned path, reads the store only for `pushed` enablements, the same as `resolveForAgent` (`backend/src/modules/context-variables/contextVariableResolverService.ts:94`, `backend/src/db/repositories/contextVariableRepository.ts:598`). Both paths change in 1a.
- The value routes accept bearer tokens as well as dashboard sessions (`requireWorkspaceSession`, `backend/src/app/http/routes/contextVariableRoutes.ts:139`).
- `on_reference` and `operator_only` are both kept out of the answer prompt: only `always` is rendered (`backend/src/modules/context-variables/contextResolutionService.ts:168-170`). The one difference is that a routine step's `{{context.<name>}}` renders an `on_reference` value and renders nothing for `operator_only` (`backend/src/modules/context-variables/routineContextRenderer.ts:9-11`).

**Correction to an accepted decision.** The product owner accepted `operator_only` as the default surfacing for classified values, on the design's claim that it keeps them out of the answer prompt. The third finding above shows `on_reference` does that too, and `operator_only` would also stop a routine step from reading the value, which contradicts "template reading comes for free". This spec therefore uses `on_reference` (D13). The intent of the decision is unchanged. The product owner confirmed `on_reference` on 2026-11-21.

**One instruction is met in part.** The change request asked for classification before both the notice and `handoff.requested` are dispatched. The notice is covered. The event is not held: it is a transactional outbox row written beside the `handoff_requested` activity for every handoff path (`backend/src/modules/conversationActivity/workspaceEventLogBridge.ts:8-18`, `specs/957-workspace-events/spec.md` D2 and D5). Holding it for a model call would either put that call inside the turn on every handoff path or make the event non-transactional. Section 7 gives what automations get instead.

## 1. Placement: extend context variables

Context variables already are the attribute layer's catalog, store and read side.

| Capability | Where it exists |
|---|---|
| Workspace definitions with description, trust tier, sensitivity | `backend/src/modules/context-variables/domain.ts:12-23`, `backend/src/db/schema.sql:2152-2167` |
| Per-agent use that follows draft/publish | `backend/src/modules/agents/agentRevision.ts:70-76`, `:117`; draft mutation at `backend/src/db/repositories/contextVariableRepository.ts:636-637` |
| Scoped values with a resolution ladder and a person scope | `domain.ts:10`, `schema.sql:2136-2145`, `backend/src/modules/chat/services/chatSessionPreparer.ts:882-890` |
| Directive conditions read the values | `backend/src/modules/context-variables/matchContextProjection.ts:91-121`, `backend/src/modules/chat/services/visitorMatchContext.ts:27-41` |
| Routine steps and skill inputs read the values | `routineContextRenderer.ts:1-12`; `contextVariableRef` in `packages/routine-definition/src/index.ts:209-212` |
| Redaction, prompt bounds, surfacing | `contextResolutionService.ts:17`, `:116-122`; `backend/src/shared/domain/behaviorConfig.ts:49-70` |
| Erasure and data-subject export | `contextVariableRepository.ts:810-849`, `:855-` |
| REST CRUD for definitions, enablements and values | `backend/src/app/http/routes/contextVariableRoutes.ts:143-322` |
| A Ray proposal primitive | `backend/src/modules/context-variables/copilotPrimitiveRegistry.ts:2` |
| A catalog editor in the dashboard | `frontend/components/dashboard/settings/assistant-context-variables-section.tsx:280`, `:657` |
| A system-written fact in the same namespace | `radioso_caller_kind`, `visitorMatchContext.ts:11`; reserved prefix at `domain.ts:60` |

What is missing:

1. **Types.** `value_type` is `string | json` (`domain.ts:5`, `schema.sql:2166`); validation is one line (`backend/src/modules/context-variables/valueCompatibility.ts:3-6`).
2. **Writers.** The only stored-value writer is the API (`contextVariableRoutes.ts:289`).
3. **Provenance.** A value row carries `last_modified` and nothing about its writer (`schema.sql:2136-2145`).
4. **A scope every channel has.** `session` is keyed by `conversations.anonymous_session_id` (`contextVariableRepository.ts:816-832`).
5. **Deterministic readers.** Rule branches resolve `fieldRef` against skill outputs and slots only (`packages/conversation-engine/src/routineFieldGuard.ts:12-45`). There is no Inbox filter and no Pulse breakdown.
6. **A change stream.** None of the seven workspace event types reports a value change (`backend/src/shared/domain/workspaceEventLog.ts:17-25`).

**Rejected: a separate `attributes` module.** Directive matching takes one bounded record (`matchContextProjection.ts:91`). Erasure and export would need a second eraser and exporter (`docs/architecture/code-map.md:1278-1291`). Routine chips would need a second reference syntax. Operators would have two catalogs.

**Rejected: renaming the API.** It breaks `/api/v1/context-variables`, the SDK, the routine token and the revision snapshot key (`agentRevision.ts:117`) for no behavioural gain.

**The model after this work:**

```
context_variables            + value_type: enum | number | boolean | date    (string, json stay)
                             + options jsonb    (enum: [{key, label, description, archived}])
context_variable_values      + scope_type: conversation | whatsapp_contact   (session, customer, agent, workspace stay)
                             + written_by_kind, written_by_ref
agent_context_variables      + source: classified                            (pushed, browser, resolver, request stay)
```

Built-ins (`page_context`, `visitor_identity`, `visitor_request`) are untouched.

## 2. Ownership: what is revisioned

**Definitions are workspace-level and not revisioned.** An option list is a reporting vocabulary shared by the Inbox filter and Pulse across agents. Definitions stay where they are (`schema.sql:2152`).

An option-list edit therefore takes effect at once on every agent, including conversations pinned to an older revision: the snapshot holds enablements, not definitions (`agentRevision.ts:63-76`). Three rules keep that safe:

- An option has an immutable `key` (a letter, then letters, digits or underscores), a `label`, a `description` and `archived`. Stored values hold the key.
- Options are archived, never deleted; at least one stays active. An archived key stays valid for stored values and filters; the classifier and the operator picker stop offering it.
- Changing `value_type` on a variable that has values is refused.

**Use is agent-level and revisioned.** A new enablement source, `classified`, sits beside `pushed` in the snapshot schema (`agentRevision.ts:72`). Test Chat on a draft classifies with the draft's enablements, the way sample values work (`docs-portal/content/operators/context-variables.mdx:101-107`).

**Sources after this work:** `pushed` is a stored value written by API, operator or routine. `classified` is a stored value the classifier also maintains. Both resolve paths read the store for both sources.

## 3. Scopes and lifetimes

**`conversation` (new), keyed by `conversations.id`.** It lives and dies with the conversation. `session` cannot serve: several conversations can share an `anonymous_session_id` (the eraser checks for it, `contextVariableRepository.ts:828-832`), and email, Slack and some API conversations never set one. Classifier output and routine write-back default here.

**Person scopes.** `customer`, keyed by `verified_customer_id`, exists and is unlocked only by verified identity (`context-variables.mdx:137-138`, `:246`). `whatsapp_contact` is new (section 10). A conversation has at most one person key, decided by its channel.

**Resolution ladder:**

```
conversation → session → person (customer | whatsapp_contact) → agent → workspace
```

**The `visitors` row is not a person key.** `visitor_key` is not a credential: anyone who learns one can group a new conversation under that visitor, and the module guarantees this grants no read access (`backend/src/modules/visitors/README.md:9-21`). Resolving visitor-row values into a turn would break that guarantee. Email, Slack and session-less MCP conversations have no visitor row at all (`visitors/README.md:39-48`).

## 4. Types and validation

| Type | Stored as | Slice |
|---|---|---|
| `string`, `json` | as today | existing |
| `enum` | option `key` | 1a |
| `boolean`, `number`, `date` | JSON boolean, number, ISO date string | 3a |

`validateValue(definition, data) → ok | { code }` replaces `isValueCompatibleWithType` (`valueCompatibility.ts:3-6`). It is a pure function in `context-variables`, and every writer goes through it. An enum value must be an active option key.

**Limits** live in `behaviorConfig`, not in env: 50 options per enum, 300 characters per option description, 8 classified variables per agent.

**Not in scope:** multi-select, date-time, a separate decimal type, reference, file.

## 5. Provenance, trust and the overwrite rule

**Provenance** is two columns on `context_variable_values`:

- `written_by_kind`: `api | operator | routine | classifier`
- `written_by_ref`: the API token id, the account id, `routineId:executionId`, or the classifier prompt version

`last_modified` is the write time. Rows written before the migration read as `api`.

There is no `integration` kind. Zapier and n8n call the bearer API, the server sees a token, and labelling a token "Zapier" would be an inferred role. The token's name tells the operator what wrote the value.

**Trust.** Trust is a property of the definition, mapped at resolve time (`contextVariableRepository.ts:616`). Classifier and routine values come from what the visitor typed, so authoring refuses to enable a `signed` variable as `classified` or to name one as a `saveTo` target. Nothing is downgraded silently at resolve time. Operator and API writes are allowed on either tier.

**Overwrite rule.** `mayOverwrite(existing, incomingKind)` is a pure function in `context-variables`:

- `api`, `operator`, `routine`: last writer wins.
- `classifier`: writes only when there is no value or the existing value was written by the classifier.

An operator's value and a host's value therefore stick with no prompt involved. **Reset to automatic** deletes the conversation's value; when the conversation's pinned release classifies the attribute, the reset enqueues `context.classification` for the conversation at once (the same request a turn writes, folded into one already waiting), so the AI fills it without waiting for a turn that may never come. Where nothing classifies the attribute the same route clears the value, labelled **Clear** in the Inbox.

**Which human values hold a variable.** A human value (`api`, `operator`, `routine`) at the `conversation`, `session` or `customer` scope is a fact about this visitor or conversation. The classifier skips the variable and clears its own older conversation value, which would otherwise hide that fact. An `agent` or `workspace` value is a default: the classifier ignores it and writes its conversation value as usual, which outranks the default in the ladder. The default applies until the classifier picks a value, and again once it clears its own.

## 6. Classification

### Why not the facet job

- Facet extraction is one job per message on a module-owned table, built for a 30-day batch census (`docs/architecture/code-map.md:2796-2828`). It writes an English phrase and an embedding (`backend/prompts/facet-extraction.md:14-22`, `schema.sql:3207-3217`), not an enum.
- Answer coverage is formed inside the answer call (`docs/answer-coverage-signals.md:17`).

A conversation attribute is per conversation and recomputed as the conversation grows. The precedent is the summary refresh: a `rerun` job keyed by conversation, where a burst of turns folds into one waiting run and a turn that lands mid-run causes one more (`backend/src/modules/chat/services/summary/conversationSummaryRefreshJob.ts:25-37`).

**Reused from facets:**

- the eligibility predicate, customer messages on end-user channels (`backend/src/modules/chat/services/facetExtractionEligibility.ts:16-23`);
- the rule that a turn whose routine held a sensitive slot is never sent (`backend/src/modules/facets/services/facetExtractionService.ts:20-21`);
- the fire-and-forget enqueue that cannot fail a turn (`facetExtractionEligibility.ts:25-28`);
- the `rewrite` model tier and the untrusted-input framing (`facet-extraction.md:4-7`).

### When it runs

**After each committed turn.** Job kind `context.classification`, `onDuplicateKey: "rerun"`, payload `{ workspaceId, conversationId }`, enqueued beside facet extraction (`chatSessionPreparer.ts:534`) only when the conversation's revision has a `classified` enablement. A value is visible from the next turn.

**Before a handoff notice.** See section 7.

There is no conversation-closed state to trigger on. The last run is the final value.

`operator_test` conversations classify, so Test Chat shows the result. Reports already exclude them (`backend/src/modules/chat/audiencePulseHistorySource.ts:120-121`), and so do the Inbox filter and Pulse breakdown.

### Cost

One `rewrite`-tier call per coalesced run, for agents with a classified variable. All of an agent's classified variables go in one call. Input is the rolling summary when one exists, the last few eligible customer messages, and the option lists. No embedding. An unchanged result writes nothing and emits no event.

### Prompt

`backend/prompts/context-classification.md`:

- the role and the untrusted-content rule;
- per variable: name, description, and each active option as `key — description`. Descriptions are in whatever language the operator writes. Keys are identifiers and are never matched against visitor text;
- output: a strict JSON schema, one property per variable, each written in order: `evidence`, one sentence in the model's own words on what the visitor stated that bears on the variable; `option_applies`, the explicit "none of these" path; and `key`, an enum of that variable's active keys or `null`. A field whose `option_applies` is false is read as `null`. The evidence makes the key follow from stated facts; it is model output derived from visitor text, so the parse discards it and it is never stored, logged, traced or exported;
- no value the conversation holds: the classifier judges the conversation, not its earlier answer.

`null` means "none of these": leave the value unset, or clear a previous classifier value. There is no built-in "unknown" option. An absent value is the unknown state and is filterable as **Not set**. An operator who wants "Other" authors it as an option.

A key outside the schema is rejected. A rejected or failed run fails the job, which retries and dead-letters under the shared runtime (`code-map.md:2741-2748`).

### Re-classification

- A new turn reruns the job.
- An option-list edit reruns nothing. The next turn uses the new list.
- There is no backfill over past conversations.

### Evals

- **Unit (TDD):** schema building, parsing, `null`, the overwrite rule, sensitive-turn exclusion, eligibility.
- **Deterministic suite** (`backend/tests/unit/eval-suite/`): labelled short conversations against a stubbed gateway. It asserts that the job is enqueued, the value is written as `classifier`, and an operator value is not overwritten.
- **Live suite** (`backend/src/modules/eval/suite/`): a small labelled set in Italian, German and English with expected keys, "none applies" cases, a mid-conversation topic change and an injection case. Scored as accuracy against the committed baseline. Mini model, small samples.

## 7. Handoff: classify before the notice

### How a notice is sent today

- The turn writes a `handoff.notify` row into `routine_action_requests` in its own transaction (`backend/src/modules/chat/infra/turnOutboxWrites.ts:22-50`). A retrieval-miss handoff queues the same action type (`backend/src/modules/chat/services/handoffOwnership.ts:80-85`).
- The `chat.action_dispatch` background job runs it after commit: 120 s timeout, five attempts (`backend/src/modules/chat/services/actions/actionDispatchJob.ts:45-54`).
- One handler serves every routine-ending notice (`backend/src/modules/chat/services/actions/routineEndingNotifyActionHandler.ts:27-34`). It resolves the conversation's stored facts at dispatch time (`:60-66`).
- That handler already makes one bounded model call inline: the AI summary, raced against a 10 s timeout, where a timeout or error logs and the notice is sent without it (`:79-121`; `backend/src/modules/chat/services/actions/routineEndingNoticeSummary.ts:16`).

### Mechanism

The notice handler classifies inline, the way it summarises inline.

1. The handler calls a narrow port, `ConversationClassifier.classifyNow({ workspaceId, conversationId, signal })`, implemented by `contextClassification`. It is the same function the background job's handler calls.
2. It races the call against a 10 s timeout and runs it concurrently with the AI summary.
3. It then resolves the notice subject, which now includes the conversation's non-sensitive attributes.
4. It dispatches.

This is the narrowest option because it adds no job-to-job waiting, no new queue state and no change to the turn. Every handoff path that queues `handoff.notify` is covered by one call site.

**Rejected: the classification job releases the notice.** The classifier would have to know about notices, and a dead-lettered classification would strand a handoff.

**Rejected: classify inside the turn.** It puts a model call on the visitor's path at every handoff site.

### Bounds and failure

- **Added latency:** at most 10 s per attempt, and none beyond the summary's own wait when a summary is also generated, because the two run together. A typical `rewrite`-tier call is one to two seconds. The job's 120 s budget is unaffected.
- **Timeout or error:** the notice is sent with the attributes already stored, which may be none. The outcome is counted (`skipped_timeout`, `failed`) and logged by error class. The notice is never retried for a classification failure.
- **Conversation with no classified enablement:** the port returns at once without a model call.
- **Race with the after-turn job:** both may run. Writes are idempotent upserts under the overwrite rule, and an unchanged value emits nothing.
- **A retried notice** classifies again, which costs one cheap call and changes nothing if the value holds.

### The `handoff.requested` event

Its payload stays `{ reason }` (`workspaceEventLog.ts:92`), written in the turn's transaction. An automation that needs the attributes has three sources:

- `context_value.changed` events, which the notice-time classification writes and which follow `handoff.requested` in the log;
- the notice webhook JSON, which carries the attributes;
- `GET /api/v1/history/chat/{conversationId}`, whose `attributes` are current.

### Escalation rules

There is no handoff rule object: handoff is requested by authored triggers and the AI never decides it silently (`docs/human-takeover.md:39-66`). Attribute-driven escalation uses levers that exist: a Rule branch to a `handoff` terminal, or a directive whose condition reads the attribute and whose binding starts a handoff routine. This spec adds no escalation engine.

## 8. Readers

| Reader | Mechanism | Slice |
|---|---|---|
| Directive conditions (prose) | Values enter the per-turn snapshot and reach the matcher and the fused planner through `projectContextForMatching` | 1 (one test) |
| Routine step instructions, skill inputs | `{{context.<name>}}`, `contextVariableRef` | 1 (one test) |
| Inbox Attributes block | Conversation detail carries `attributes` | 1c |
| Inbox filter | Filter on conversation-scope enum values | 1c |
| Routine Rule branches | `fieldRef: "context.<name>"` on field guards | 3b |
| Handoff notice | Subject resolver reads non-sensitive values | 5 |
| Pulse breakdown | Split a topic by one enum variable | 7 |

**Directive conditions.** Enum values are projected as `{ key, label }`, so a condition written in the operator's language matches the label. Two existing limits apply: sensitive values arrive as `[redacted]` (`context-variables.mdx:344-346`), and the match record holds at most 12 variables (`behaviorConfig.ts:65-69`). Classified variables sort ahead of host JSON variables in that bound.

**Answer prompt.** The default surfacing for a `classified` enablement is `on_reference` (D13). The value steers conditions and branches, a routine step that names it can read it, and it is not written into the answer prompt. The answer model already read the conversation, and showing it the classifier's opinion lets a classifier error compound. An operator can change the surfacing per agent.

**Inbox filter.** It reads conversation-scope values of non-sensitive enum variables, plus **Not set**. It needs an index on `(variable_id, scope_type, data)`; the existing index covers lookups by scope id only (`schema.sql:8797`). The index ships in 1a, in a second migration (271) that builds it after the catalog changes commit, so no read waits for the build.

**Rule branches.** `evaluateFieldGuard(guard, variables, skillResult, now)` (`packages/conversation-engine/src/routineRunner.ts:309-310`) gains a third source through an optional `contextValueReader` port beside `contextRenderer` (`routineRunner.ts:108-109`). The `context.` prefix is explicit, so resolution never guesses between a slot and a variable of the same name. The validator extends its op and type check (`backend/src/modules/routines/validator.ts:578-598`) to the variable's type and, for `equals` and `in`, to the option keys. A guard on a `sensitive` or `operator_only` variable is allowed: it runs in code. Its trace records the reference and the outcome, never the value.

**Pulse.** Audience Pulse defines a `ConversationValueBreakdownReader` port. The context-variable repository implements it and composition binds it.

**Structured criteria (slice 8, conditional).** `coverageCriteria` is the precedent for a deterministic eligibility filter (`packages/conversation-contract/index.d.ts:69-72`, `packages/routine-definition/src/index.ts:518`). A `contextCriteria` beside it is built only if live evals show prose conditions on enum values misfire.

## 9. Routine write-back

**Authored on the slot:**

```
slot.saveTo?: { contextVariable: <name>, scope: "conversation" | "person" }
```

It is added to `routineSlotSchemaFor` (`packages/routine-definition/src/index.ts:231-244`) and picked explicitly in the routine editor's slot row. Nothing is inferred from a slot's key or type.

**Validated at save and publish** (`backend/src/modules/routines/validator.ts`):

- the variable exists and the agent enables it as a stored source;
- the types are compatible: `text` and `email` to `string`, `number` to `number`, `boolean` to `boolean`, `date` to `date`. `item` is not mappable;
- the variable's trust tier is `unverified`;
- a `sensitive` slot (`routine-definition/src/index.ts:39-47`) saves only to a `sensitive` variable;
- two slots of one routine do not save to the same variable and scope.

**Written at the routine's ending, in the turn's transaction**, beside `routine.completed` (`turnOutboxWrites.ts:111`). Both `complete` and `handoff` terminals write. It is not written at slot fill: a mutable slot can still be corrected (`routine-definition/src/index.ts:235-239`), consent may not have been given, and an abandoned routine leaves no facts. A routine that ends without its terminal (`routine_stuck`, `routine_consent_declined`, `docs/human-takeover.md:47-58`) writes nothing.

**Person scope.** `person` resolves to the conversation's person key: the verified customer id, or from slice 4 the WhatsApp number. A conversation with no person key writes nothing, records `no_person_key` in the routine trace and increments a counter. The routine still completes. No other scope is substituted.

**Conflicts.** Last writer wins among routine, operator and API. A routine value replaces a classifier value.

**Consent withdrawal.** Withdrawing a routine's consent removes its events by routine id and slot keys (`backend/src/modules/workspaceEventLog/README.md`, the consent withholder). `written_by_ref` lets the same withdrawal delete the values that execution wrote.

### Slice 3a settled

- **Types.** `boolean` is stored as a JSON boolean, `number` as a finite JSON number, `date` as an ISO calendar date string (`YYYY-MM-DD`, checked by a `Date.UTC` round-trip in `isIsoCalendarDate`, the one check `@radioso/conversation-contract` gives the engine's slot values, a routine tool call's input and an attribute's value). Migration 278 widens `context_variables_value_type_check` and adds `routine_slot.save_to_context_variable` / `save_to_scope` with a pairing CHECK, all `NOT VALID`; 279 validates them, as 270/271 do. `{{context.x}}` and directive conditions read the JSON value as is (`true`, `4`, `2026-11-24`); the Inbox shows a Yes/no value as Yes or No. Classification and the Inbox filter stay Choice-only. Inbox **Set** stays Choice-only, since a typed editor per type is its own change across REST, MCP and the block; **Clear** (`DELETE`, MCP `reset_conversation_attribute`) takes a conversation's own value of any type that is not Private, so a wrong value a routine saved can go without the values API.
- **Which slot types save where** is `routineSlotSavesToValueType` in `routine-definition/src/saveTo.ts`, shared by the validator and the editor's picker. There is no fixed-option slot type, so nothing maps to `enum`.
- **Validation** (`routines/saveTargetValidation.ts`) emits `save_to_unknown_attribute`, `save_to_attribute_not_stored`, `save_to_type_mismatch`, `save_to_attribute_signed`, `save_to_sensitive_slot_not_private` and `save_to_duplicate_target` at `slot:<key>.saveTo`. "Exists" means enabled for the agent; "stored" means `pushed` or `classified` (the picker offers `pushed` only, since the AI fills Choice attributes and no slot saves to one). The duplicate rule runs without the agent's attributes; the others need them, as the binding rules do. Saving checks the draft's enablements; publishing checks the candidate release's (`saveTargetAttributes`), so a target disabled in the draft fails the publish. `contextVariable` takes any attribute name (`contextVariableNameSchema`, 1–120 characters, shared with the attribute definition).
- **The write.** The captured save transition carries `slotSaves` (`routineSlotSaves`, only a `completed` state with `terminalKind` `complete` or `handoff`). `PostgresAssistantTurnPersistence` hands them to `ContextValueSaver.saveAll(trx, …)` just before it inserts the turn's audit event, so the values, their `context_value.changed` events and `routine.completed` commit or roll back with the turn. The saver locks the definition by name `FOR KEY SHARE` after the turn's conversation row lock (`conversationLockOrder.ts`), re-checks trust, sensitivity and type against the definition as it is now, and stores under `mayOverwrite`. An update that changes a definition's trust tier takes the definition `FOR UPDATE`, as type, options and sensitivity changes do, so a save never lands in an attribute made proof under it. The saver reads the conversation's save context in the turn's transaction (`readConversationSaveContext`): a `person` save keys on the `verified_customer_id` bound on the conversation row, the one readers and withdrawal use, and a save to an attribute the conversation's pinned release does not keep (enabled, `pushed` or `classified`) is skipped as `not_enabled`. Saves run sorted by attribute name and scope, so two turns of one person lock its rows in one order. The writer is `{ kind: "routine", ref: "<routineId>:<executionId>@<conversationId>" }`; the event's `routineId` is passed explicitly. Delivery is woken by the turn's existing after-commit wake. A visitor's post-completion correction re-saves only the fields the correction changed, so a newer API or teammate value of an untouched field stays. A `safe_test` or review turn writes nothing (`TurnExecutionCapabilities.routineValueSaves: "trace_only"`) and traces each save as `not_saved_in_test`.
- **Outcomes.** `written`, `unchanged`, `kept`, `no_person_key`, `gone`, `not_enabled`, `refused_type`, `refused_trust`, `refused_sensitive`, on the routine stage's sub-trace as `saves` (slot key, attribute, scope, outcome; never the value), or on the stage's `outputs.saves` where the stage has no sub-trace (a decision's resume, a correction after completion), and counted in `radioso_context_value_writes_total{writer="routine", outcome}`, `failed` included. Two more appear on the trace and are not counted: `withdrawn`, when a consent of the routine was withdrawn in the conversation, and `not_saved_in_test`.
- **Withdrawal.** `ContextValueConsentWithholder` deletes, in the withholding's transaction and in one SQL statement, every value whose writer is a run of a withdrawn routine in this conversation (ref prefix `<routineId>:` or `<routineId>@`, suffix `@<conversationId>`), in the conversation's scope and the customer its row is bound to. Another conversation's run keeps its person values, since that conversation's consent covers them. A turn that raced a withdrawal re-applies it to its own run only (`savedByRuns`), and a run of a routine withdrawn in the conversation saves nothing (`withdrawn`). It records no event, and the event withholder removes the routine's `context_value.changed`.
- **Test Chat** saves nothing: its test-local attribute store holds the classifier's Choice keys as strings, so it cannot take a typed routine value cheaply. Its trace shows each save's target and scope as `not_saved_in_test`, never the value.
- **Queue review.** No new queue, worker payload or retry: the write is inside the turn's transaction, and event delivery reuses the existing wake.

**Decisions to confirm:**

1. Withdrawal deletes every value the routine saved, not only the consented fields', matching the event withholder, but only from runs in the withdrawing conversation: a `person` value another conversation's run saved stays.
2. `unchanged` is reported for the same writer and run with the same value, and for a value equal to one a teammate or the host wrote, which keeps that writer, so a later withdrawal leaves the teammate's value. Over a routine's or the classifier's equal value, a run rewrites the provenance and reports `written`, with no event (the value did not change).
3. The picker lists only compatible attributes; a stored target that no longer qualifies stays visible, marked, and validation reports it.
4. Inbox **Set** stays Choice-only; **Clear** takes a value of any type that is not Private.
5. The conversation-kit host's `parseRoutineSlot` drops `saveTo`: a kit host has no attribute store.

## 10. The WhatsApp number as a person key

### Today

- The webhook is authenticated by Meta's `X-Hub-Signature-256` (`backend/src/modules/connectors/plugins/whatsapp/whatsappWebhook.ts:228-229`), so the `wa_id` on a message is attested by Meta.
- WhatsApp turns enter chat with a conversation id and `sourceChannel: "whatsapp"` and no customer identity (`backend/src/modules/connectors/plugins/whatsapp/whatsappMessageHandler.ts:606-613`).
- A number has one contact row per workspace, pointing at its latest conversation (`schema.sql:2089-2097`, `:5880`; `backend/src/modules/connectors/plugins/whatsapp/whatsappPersistence.ts:452-453`).
- There is no WhatsApp data-subject finder. The list holds web, email and Slack (`backend/src/app/composition/dataSubjectAccess.ts:26-30`).

### Choice: a new scope type, `whatsapp_contact`, keyed by `wa_id`

**Rejected: a namespaced key in the `customer` scope** (`whatsapp:<wa_id>`). Three places in the code make it unsafe:

- The value routes take any string as a scope id (`contextVariableRoutes.ts:289-299`), and a signed identity token carries any `customerId` the host chooses (`context-variables.mdx:147-158`). A host customer id that happens to read `whatsapp:39…` would resolve a WhatsApp person's values on the web, and the reverse.
- `eraseVerifiedCustomer` deletes `customer` rows by id (`contextVariableRepository.ts:839-847`), and a data-subject reach lists `verifiedCustomerIds` (`backend/src/shared/domain/dataSubjectAccess.ts:41-46`). Phone numbers in that list would be treated as host customer ids everywhere it is read.
- A prefix convention is parsed by string matching in every reader.

A scope type is a closed, checked value (`schema.sql:2144`). It keeps the host's namespace untouched and gives the channel its own erasure and export path.

**Rejected: a generic `channel_identity` type with a namespaced id.** It brings the prefix parsing back. A channel qualifies as a person key only when its identity is attested, which is one channel today.

### Resolution

- The WhatsApp handler passes the person key with each turn, `{ id: waId }` under the kind composition binds to the connector, on the connector chat port, the way the web path passes a verified customer id per turn. Chat does not read WhatsApp tables, and nothing is stored on the conversation.
- The ladder places it at the person step (section 3). A WhatsApp conversation has no verified customer id, so the two person scopes never meet in one conversation.
- Values written under one channel's key are read only on that channel. Nothing links a number to a customer id.
- A host may write `whatsapp_contact` values through the value route. It knows its customers' numbers.

### Erasure, export, retention

- **Erasure.** A new port, `ChannelPersonDataEraser`, sits beside `VerifiedCustomerDataEraser` (`backend/src/shared/domain/conversationDataErasure.ts:34-38`), and `context-variables` implements it. The WhatsApp eraser already finds the numbers whose latest conversation is being erased, before the contact rows cascade (`whatsappPersistence.ts:459-476`). Those numbers are the keys handed to the new port, in the same transaction. Composition binds the two.
- **Lifetime.** Person values for a number last as long as the number's latest conversation, the same rule the WhatsApp message log follows (`whatsappPersistence.ts:452-457`). Erasing an earlier conversation leaves them.
- **Retention.** The retention sweep uses the same erasers (`code-map.md:1408-1425`), so when a number's latest conversation ages out, its person values go with it. There is no separate window.
- **Data-subject requests.** A `WhatsAppNumberIdentityFinder` joins the finder list, so a subject can be found by number. `DataSubjectReach` gains the channel person keys beside `verifiedCustomerIds`, and `ContextVariableValueExporter` exports the `whatsapp_contact` rows in the existing `context_values` section.
- **Logs.** A `wa_id` is a phone number. It is never logged; the existing log-safe handling applies (`backend/src/shared/observability/logging/logSafeValues.ts`).

### Slice 4 settled

- **The turn's key.** `@radioso/connector-api` gains a generic `ConnectorPersonKey { id }` and an optional `personKey` on `ConnectorChatPort.answer`. The kind is composition's: `app/composition/connectorChat.ts` binds `whatsapp_contact` to the WhatsApp connector's id, so no other connector can run a turn as a number. The port reads the id in the channel's stored form (`channelPersonKeyId`, `shared/domain/channelPersonKey.ts`) and forwards it as `channelPersonKey` on the text, photo and pick paths. A key from a connector bound to no kind, or one that cannot be read, never blocks the reply: the turn runs with no person and `connector_person_keys_unused_total{connector, reason}` counts it. `AssistantChatRequest.channelPersonKey` carries the key to `PrepareChatSessionInput`, and `PreparedSession.channelPersonKey` keeps it for the turn: the host-variable ladder reads it, and the turn persistence port hands it to the routine's slot saves. A turn that carries none (a connector review, an approval resume) reads the conversation's recorded one (`turnChannelPersonKey.ts`), so every turn of a WhatsApp conversation has the same person. Nothing is stored on the conversation row.
- **Outside a turn.** The Inbox, the classifier, an edit's read-back and the consent withholder have no turn to carry the key, and a number's contact row names only its latest conversation. Migration 282 adds `connector_whatsapp_conversations (conversation_id PK, workspace_id, wa_id)`, owned by the WhatsApp plugin. The plugin writes it through a generic hook on the chat port, `answer({ onMessageStored })`, called with the conversation id as soon as the turn stores the visitor's message: before any model call, before the turn commits its jobs, and also when the turn then fails. A hook that fails fails the turn. A shared port, `ConversationChannelPersonKeys.personKeyOf` (`shared/domain/channelPersonKey.ts`), is bound by composition (`app/composition/conversationReadSources.ts`) to `WhatsAppConversationPersonKeys`, so `context-variables` and chat read a channel person without knowing WhatsApp. It answers without a query for a conversation whose source channel is not WhatsApp, and a turn reads it beside its other preparation reads. The ladder's person rung alone decides between a verified customer and a channel person. The backfill can name only each number's latest conversation.
- **Resolver cache.** A channel person key is a visitor scope, so a resolver caches under the number and a second number's turn never reads the first's value. The skill is handed the first scope past the conversation that is not a channel person key, so a number never reaches a host's skill or webhook; a WhatsApp turn hands it the agent scope.
- **Number rule.** One reading of a typed number (`readWhatsAppNumber`): spaces, dashes, dots, brackets and a leading `+` are dropped, and what is left must be `^[1-9]\d{5,14}$`, country code first. `ContextVariableService` applies it to a `whatsapp_contact` scope id, and the finder to a lookup query and an identity key; a `0` or `00` prefix or any other malformed number answers `400` and is never reported as no match. The key is Meta's `wa_id`, which in some countries differs from the number people dial.
- **Event.** A routine's save to the person records `context_value.changed` with the saving conversation as its subject and `scope` `customer` or `whatsapp_contact`, never the customer id or number, so the event cascades with that conversation and the consent withholder removes it with the routine's other events. A value route write to a person scope has no conversation and records none. Version stays 1: the `scope` enum widens and every older event still parses. Person values take the same per-value advisory lock as conversation values.
- **Withdrawal.** `ContextValueConsentWithholder` also deletes `whatsapp_contact` rows a withdrawn routine's run saved, pinned to the conversation's own number through `ConversationChannelPersonKeys`, as the customer branch is pinned to the conversation's customer.
- **Data-subject requests.** `WhatsAppNumberIdentityFinder` (`whatsapp/whatsappNumbers.ts`): kind `whatsapp_number`, channel `whatsapp`, key the number's digits, label `+<digits>`, record ids the conversation ids, so an audit event never names the number. It finds a number by its recorded conversations, the contact row's, its logged messages or the values kept for it, and returns it as a `channelPersonKey`. An erasure deletes what is kept under those keys itself (`ConversationErasure.eraseChannelPersons`: the values and the message log), with or without a conversation. `WhatsAppContactExporter` writes `whatsapp_contacts`; `WhatsAppMessageLogExporter` writes `whatsapp_messages`, a projection of the subject's own messages (direction, type, status, time, text, media id and file name), because a webhook body can hold other senders' messages. A paged export or erasure carries the number-level records on the one page that lists the first reached conversation. `connector_whatsapp_conversations` is excluded as the finder's index. The surface is REST and the SDK: data-subject requests stay a stated exclusion from Ray and operator MCP (`catalogCoverage.ts`), and there is no dashboard screen.
- **Number changes.** Meta reports a changed number as a signed `user_changed_number` system message sent from the old one. The webhook reads it after the phone-number-id check and deletes the person values under the old number in that workspace (`WhatsAppNumberChanges`, over `ChannelPersonDataEraser`); conversations and the message log stay. `whatsapp_number_changes_total{outcome}` counts it.
- **Observability.** Two counters: `connector_person_keys_unused_total{connector, reason}` and `whatsapp_number_changes_total{outcome}`, both log-safe. A save is counted by `radioso_context_value_writes_total{writer, outcome}` as before. `whatsapp-turn.integration.test.ts` drives real turns from Meta's webhook (a routine person save, an unreadable sender, a refused send, a failing model, a failed delivery, a number change) and fails when the number's digits appear in a log line, metric, span, workspace event, background job or audit record. A source scan (`whatsappNumberNeverObserved.test.ts`) covers the branches those turns do not drive.
- **Queue review.** WhatsApp turns cross no queue: the handler runs the turn, and recovery re-reads the inbound log, whose `wa_id` it derives the key from. `personKey` is optional, so a connector that sends none runs as before. `context_value.changed` widens additively. No AMQP payload, worker dispatch or new env var.
- **Known limits.** Retention reaches a number's values through its latest conversation, so a value for a number that never wrote stays until a data-subject erasure. A number's conversations from before migration 282 other than its latest are not recorded against it, so the finder reaches only that latest one of them. A number reassigned without Meta's report keeps its values. A sender id that is no phone number has no person and no identity to look up. `connector_whatsapp_message_log` is pruned at 90 days.

### Email

Email sender addresses are not a person key. A sender address is spoofable without DKIM and SPF results. Email conversations use the `conversation` scope only.

## 11. Surfaces

### REST and SDK

No new resource. Changes to existing shapes:

| Change | Slice |
|---|---|
| Definition bodies: `valueType` gains `enum`; `options` for enum | 1a |
| Value body: `scope.type` gains `conversation`; value responses gain `writtenBy` | 1a |
| Enablement body: `source` gains `classified` | 1b |
| Conversation detail (`GET /api/v1/history/chat/{id}`) gains `attributes` | 1c |
| History list gains an attribute filter | 1c |
| `PUT` and `DELETE /api/v1/history/chat/{conversationId}/attributes/{name}` | 2 |
| `valueType` gains `boolean`, `number`, `date`; routine slot gains `saveTo` | 3a |
| Field guard `fieldRef` accepts `context.<name>` | 3b |
| `scope.type` gains `whatsapp_contact` | 4 |

The operator route exists because the value routes require `workspace.agents.manage` (`contextVariableRoutes.ts:141`, `:289-292`), which a teammate answering in the Inbox should not need. It takes the takeover permission, stamps `operator` provenance from the session and writes a content-free audit event. Both routes call one service.

Slice 2 settled the operator routes as follows (`ConversationAttributeEditService`, `backend/src/modules/context-variables/conversationAttributeEdits.ts`):

- Session-only, like the Inbox's other conversation actions: the signed-in teammate is the writer (`ref` is their user id). A bearer credential gets `401`; the values API is the machine path.
- `PUT` sets Choice attributes only. It takes `{ "value": "<option key>" }`, validated by `validateValue`, so an archived or unknown key is refused with `400` naming the active keys. A set of any other type is refused as `not_choice`: a free-text editor adds little over the values API. `DELETE` takes any type that is not Private (slice 3a), so a wrong Number or Date a routine saved can be cleared.
- A Private attribute is refused with `400 attribute_not_editable` and `details.reason: "private"`, rather than `403`, which callers read as a permission problem: a teammate never sees a Private value, so they neither overwrite nor clear one. `not_choice` uses the same code.
- An unknown attribute or conversation answers `404`.
- `DELETE` is idempotent: a conversation with no value of its own answers `200` unchanged, with no audit event and no classification run.
- `PUT` is idempotent too. Setting the option a teammate already set for the conversation writes nothing, audits nothing and counts `unchanged`. Setting the option the classifier, the host's API or a routine set rewrites only the provenance to `operator`, which pins it against the classifier: it is audited and counts `written`, and records no `context_value.changed`, since the value did not change.
- An edit reads the conversation once (its rungs and the variables its pinned release classifies, through the agents module's narrow `findRevisionEnablements`, which returns the release's enablements without the rest of its snapshot) and passes that read through the write and the read-back.
- Both answer `ConversationAttributeChange`: `{ attribute: ConversationAttribute | null, classificationQueued: boolean }`, the attribute as the conversation reads it afterwards (after a reset, an inherited session or customer value).
- The audit event (`conversation_attribute.set` / `conversation_attribute.reset`, metadata: actor user id, surface, conversation id, variable id) is written after the value commits, as `set_triage_state` does; a failed audit write is logged, not thrown, because a retry would edit again.
- `ConversationAttribute` gains `classified` (the conversation's pinned release classifies it), and the conversation detail gains `attributesEditable`, true for a signed-in teammate holding the takeover permission, so the Inbox shows the block read-only otherwise.

Each row changes the OpenAPI contract. Each PR runs `cd typescript-sdk && pnpm run sync` and commits the snapshot; the MCP server package's generated types follow (`packages/radioso-mcp-server/src/generated/openapiTypes.ts`).

### Workspace event (slice 2)

`context_value.changed`, version 1:

```
{ variableId: uuid, variable: string, valueType,
  scope: "conversation" | "customer" | "whatsapp_contact",
  value: <typed value> | null, redacted: boolean,
  writtenBy: "api" | "operator" | "routine" | "classifier",
  routineId: string | null }
```

`variableId` keys the attribute across a rename. `value` is required and null for a cleared or Private value. `operator` covers a teammate in the Inbox, through Ray and through an operator MCP client.

- **Scopes that emit (decided in slice 2).** Only `conversation`-scope values. The log's subject is a conversation, the event cascades with it, and the consent withholder keys on it. A session value spans conversations, a customer value has none, and an agent or workspace value is a default, so none has a conversation to attach to. Slice 4 adds `customer` and `whatsapp_contact` for a routine's save to the person, with the saving conversation as the subject (section 10, "Slice 4 settled"). Writes the resolver cache makes do not emit: composition builds that repository with `null` events, explicitly, and every other construction is handed the recorder and the delivery wake. Deleting an attribute cascades its values away and records no event.
- `routineId` names the routine whose write it was (the part of the writer ref before the run id), null for any other writer, so the consent withholder deletes a withdrawn routine's value events the way it deletes its `routine.completed`.
- "Changed" compares the value alone: the same value from a different writer records nothing. A delete records `value: null`.
- No migration: `workspace_events.type` is checked by pattern, not by list.

- Recorded through `WorkspaceEventRecorder` in the writer's transaction, only when the stored value changed. Once that transaction commits, the shared write path (`ContextVariableValueWrites`) calls the `WorkspaceEventDeliveryWake`, so every writer (Inbox, Ray, MCP, classifier, values API) wakes delivery once, without the minute sweep.
- A `sensitive` variable's event carries `value: null, redacted: true`, following `sensitiveSlotKeys` on `routine.completed` (`workspaceEventLog.ts:93-99`).
- Making a variable `sensitive` (a definition edit or an applied proposal) redacts its earlier `context_value.changed` events to `value: null, redacted: true` in the same transaction, keyed on `data.variableId`. The log is not append-only (no trigger, no hash chain; the withholder and the document eraser already remove rows), so the redaction is an `UPDATE`. The edit locks the definition row for update, so a value write in flight (which key-shares it) commits its event first and is redacted with the rest. Already-delivered webhook payloads are not recalled. No migration.
- Two writers of one conversation's value queue on a per-value advisory lock, so each compares against what the one before committed (READ COMMITTED); an integration test races a teammate's set against a classifier write and checks the final value follows the overwrite rule and the events match the stored changes one to one.
- Read permission is the history permission, as for other conversation events.
- It cascades with its conversation and joins the consent withholder.

### Queue review

- `context.classification` rides the shared `background_jobs` table and its existing wake. Its payload names a workspace and a conversation.
- The notice-time classification runs inside `chat.action_dispatch`; that job's payload is unchanged.
- Event delivery reuses the existing delivery job.
- No new queue, no AMQP payload, no document-worker dispatch change, no new env var.

### Ray and operator MCP

- `contextVariables.definition.propose` (`copilotPrimitiveRegistry.ts:2`) learns `valueType`, `options` and the `classified` source, so Ray can propose an attribute and its classification as one draft diff.
- Routine proposals pick up `saveTo` through the shared schema.
- The per-scope value routes stay a stated exclusion in the coverage map: they are visitor data.
- The operator set and reset routes are reached through `set_conversation_attribute` and `reset_conversation_attribute` (slice 2), not excluded: correcting the AI's label is the task an operator brings to Ray, and the tools call the same edit service with the same refusals. They follow `set_triage_state`: shape `act`, scope `operator:act`, retry `{ effect: "act", idempotent: true, operationIdentity: "client" }`, since a repeated set lands on the same value and a repeated reset finds nothing to delete. They need `workspace.history.read` and `workspace.conversation.takeover`, take an explicit conversation id, and return the attribute as `conversation_transcript` reads it.
- A conversation's attributes are read the way the Inbox reads them (slice 1c): `conversation_transcript` returns them, Private values redacted, and `conversation_history_search` filters by a Choice option. Both map to the history routes already covered (`getHistoryConversation`, `listHistory`).
- Tool descriptions stay under the 2,048-character cap.

### Zapier and n8n (slice 6)

A trigger **Attribute changed** on the new event, in the REST-hook pattern of the existing triggers (`packages/zapier/triggers/`), and an action **Set attribute** on the value route (`packages/zapier/creates/`). The n8n node gets the same pair and its own release.

### Dashboard

- **Catalog** (`assistant-context-variables-section.tsx`, 672 lines): renamed **Attributes**; a type picker; an options editor as its own component, because the file is near the 1,000-line ratchet.
- **Agent Context section:** **Classify automatically** per enum attribute.
- **Inbox reading pane:** an **Attributes** block, after the situation card and before the messages, showing each value and who set it; the conversation drawer shows it too. Read-only in 1c. In slice 2 a Choice row opens a menu of its active options; a conversation-scope value whose writer is not the classifier (a teammate, the host's API or a routine) offers **Reset to automatic** where the conversation's agent classifies the attribute, **Clear** where nothing does, matching the route, which resets any conversation-scope value (a takeover teammate can already overwrite an API value with a set, so refusing a reset of one protects nothing); when someone other than a teammate wrote the value, its current option stays selectable, and picking it keeps it as the team's; **Set attribute** lists the non-Private Choice attributes with no row. An edit's response replaces the row at once and stays over any read that started before it, a reloaded detail included, until a read the block starts after it returns. A reset that queued the AI reads the attributes again about 3 s and 10 s later, the schedule the live re-read uses after a message, so the AI's value appears on a finished conversation. The workspace catalog the menus offer is one cached read per workspace, shared with the Inbox's attribute filter. Other open viewers of the conversation see an edit on their next re-read or reload: no workspace invalidation kind refreshes an open conversation's detail (the existing kinds refresh lists), and slice 2 adds no invalidation contract.
- **Inbox filter** by attribute.
- **Routine editor:** **Save to** on a slot row (3a); a context chip in the Rule builder (3b).

Playwright covers the journeys.

## 12. Module answers

### `backend/src/modules/context-variables/` (extended)

- **Knows:** definitions, types and options, scopes and the ladder, value validation, provenance, the overwrite rule, redaction, bounds.
- **Must not know:** LLMs or prompts, classification timing, routines, chat turns, WhatsApp tables, HTTP, events.
- **Ports it exposes:**
  - to chat: `ConversationValueWriter` and the existing resolution reader;
  - to classification: `ClassifiedVariableReader` and the same writer;
  - to the engine: `contextValueReader`, beside `routineContextRenderer`;
  - to Audience Pulse: the breakdown reader Pulse defines;
  - to privacy: the existing eraser and exporter, extended to the two new scopes, and `ChannelPersonDataEraser`.
- **Direction:** unchanged. Chat, routines and classification depend on its `public.ts`. It depends on none of them. Change events go out through `WorkspaceEventRecorder` from `shared/domain`, handed in by composition.

### `backend/src/modules/contextClassification/` (new)

- **Knows:** the prompt, how to build a JSON schema from described options, how to parse the result, the job kind, the model tier.
- **Must not know:** how values are stored or overwritten, what a directive, routine or notice is, chat turn internals, facets, the event log.
- **Ports it consumes:** `ClassifiedVariableReader` and `ConversationValueWriter`; a `ConversationExcerptReader` it defines, implemented by chat; the model gateway.
- **Ports it exposes:** `ContextClassificationQueue.enqueue` to chat, in the shape chat holds for facets (`backend/src/modules/chat/services/chatService.ts:239`); `ConversationClassifier.classifyNow` to the notice handler.
- **Direction:** it depends on `context-variables` and `shared`. Chat depends on its two ports. It never imports chat. Its handler is registered in `backend/src/app/composition/backgroundJobHandlers.ts` (`code-map.md:2767-2769`). Composition assembles.

### `packages/routine-definition`, `packages/conversation-engine` (touched)

- `routine-definition` learns `slot.saveTo` and the `context.` prefix as schema. It learns no storage.
- The engine learns one optional reader port. It decides nothing about what a context variable is.

### WhatsApp connector plugin (touched, slice 4)

- **Knows:** the `wa_id` of a message, the number each of its conversations is with (`connector_whatsapp_conversations`), and which numbers an erasure reaches.
- **Must not know:** the value table.
- It passes the person key on the connector chat port, answers `ConversationChannelPersonKeys` for readers outside a turn, finds and exports a data subject by number, and reports erased numbers to `ChannelPersonDataEraser`.

## 13. Privacy and observability

| Destination | What may go there |
|---|---|
| Classifier prompt | Conversation text the answer model already receives, minus turns whose routine held a sensitive slot; option keys and descriptions. No values of other variables |
| Classifier output | Keys only. The per-variable `evidence` the model writes is discarded at parse |
| Directive matcher and planner | Non-sensitive values, bounded; sensitive as `[redacted]` (`matchContextProjection.ts:85-89`) |
| Answer prompt | Per surfacing; classified defaults to `on_reference` |
| Logs, metrics, spans | Variable ids, value types, writer kinds, counts, outcome enums, prompt version. Never a value, including an enum key, and never a `wa_id` |
| Workspace events, Zapier, n8n, notice webhook | Non-sensitive values; sensitive as `redacted: true` or omitted |
| Inbox | Values with provenance for teammates with history access; sensitive redacted by the backend (`context-variables.mdx:392-393`) |
| Inbox filter, Pulse | Non-sensitive enum values |
| Data-subject export | The `context_values` section, extended to both new scopes and `writtenBy` |
| Audit | Operator set and reset: content-free (variable id, conversation id, actor) |

**AI-inferred special-category data.** Classifying a conversation as a health matter processes special-category data though nobody filled a form field. `classified` on a `sensitive` variable is refused. Every classified value is therefore one the operator declared non-sensitive, and the docs say what that declaration means. #1539 decides the rest.

**Deletion and retention.**

- Conversation-scope values are erased with the conversation by extending the existing eraser (`contextVariableRepository.ts:810-837`).
- Customer-scope values go with the verified customer (`:839-847`).
- WhatsApp person values follow section 10.
- Deleting a variable cascades its values (`schema.sql:11882`).
- Retention uses the same erasers.
- The schema contract tests that demand an eraser, an export section or a stated reason for every conversation-keyed column cover the new scopes and the new event.

**Observability added:**

- `radioso_context_classification_runs_total{trigger, outcome}`: trigger `after_turn | handoff_notice`; outcome `written | unchanged | no_option | skipped_sensitive | skipped_override | skipped_timeout | invalid | failed`
- `radioso_context_value_writes_total{writer, outcome}`, including `refused_type`, `refused_trust`, `no_person_key`. It ships in PR 1b, when the classifier becomes a second writer and a refused or kept write stops being an HTTP response a caller sees. In 1a the API is the only writer, and its outcomes (written, `409` kept or changed mid-write, `404` no conversation) are already counted by `http_requests_total{method, route, status_code}`.
- `radioso_conversation_attribute_edits_total{action, outcome}` (slice 2): action `set | reset`; outcome `written | cleared | unchanged | not_found | refused_type | refused_private | refused_option | failed`. The `context_value.changed` event is the per-change record; the counter never carries an attribute or value.
- one span per classification run with counts and the prompt version
- the notice handler's span records the classification outcome beside the summary outcome

## 14. Slices

File counts are files created or meaningfully edited, tests included, generated SDK snapshot excluded.

### Slice 1: "The AI labels a conversation and the operator sees and filters by it"

**PR 1a: typed attributes, no LLM (about 24 files).**
Two migrations (270: enum type, `options`, `conversation` scope, provenance columns; 271: CHECK validation and the filter index) with both DB snapshots; domain types, `validateValue`, `mayOverwrite`; both resolve paths read the `conversation` scope; eraser and exporter for the new scope; REST bodies; catalog renamed **Attributes** with the options editor; Ray adapter fields; docs. Useful alone: a host can put a typed value on any conversation by id, on any channel. Contract change: yes.

**PR 1b: classifier and toggle (about 26 files).**
The `contextClassification` module, prompt and job; enqueue in chat; the excerpt reader; composition; the `classified` source in the snapshot schema, routes and Ray adapter; the agent toggle; unit, deterministic-suite and live eval cases; module README and docs. Contract change: yes.

**PR 1c: reading-pane block and filter (about 16 files).**
`attributes` on conversation detail; the history list filter; the read-only **Attributes** block; the Inbox filter; Playwright for both; one test that a directive condition reads a classified value and one that a routine step renders it; docs. Contract change: yes.
The filter's query must carry `filterIndexPredicate` (`backend/src/db/repositories/contextVariableValueReads.ts`), the filter index's predicate: Postgres uses a partial index only when the query implies its predicate, and `data = $1` alone does not. A test runs `EXPLAIN` on the filter query and expects the index.

**What slice 1 proves:**

1. An operator sees what the AI decided, and who decided it, on every conversation, and can narrow the Inbox to one value.
2. One namespace holds: no second catalog and no second reference syntax.
3. Classifier accuracy and cost on the async `rerun` shape, in more than one language.

### Later slices

| Slice | Contents | Files per PR | Contract |
|---|---|---|---|
| 2 | Operator set and reset from the drawer; audit event; `context_value.changed` with cascade and withholder | about 18 | route, event type |
| 3a | `boolean`, `number`, `date`; `slot.saveTo`; write at ending; consent-withdrawal deletion; **Save to** in the routine editor | about 16 | routine schema (REST, SDK, MCP types, agent bundle, revision snapshot) |
| 3b | `context.` field guards; engine reader port; Rule builder chip | about 12 | field guard reference |
| 4 | `whatsapp_contact` scope; person key on the connector chat port; `ChannelPersonDataEraser`; WhatsApp identity finder; export | about 16 | scope type |
| 5 | Notice-time classification; attributes in the handoff notice (email, Slack, webhook JSON) | about 12 | notice webhook JSON |
| 6 | Zapier trigger and action; n8n trigger and action | about 8 per package | none in the backend |
| 7 | Pulse breakdown reader and one split control | about 10 | Pulse response |
| 8 | `contextCriteria` on directives and routine activation, only if evals require it | about 20 | directive and routine schema |

Slices 2 to 5 are independent of each other once slice 1 is in, except that 4 follows 3a (the first person-scope writer other than the API).

PR 1b is the largest at about 26 files. They are one new module plus one edit per layer it is wired through, not many modules changing for one concern.

## 15. Out of scope

- Contacts, companies, custom objects, references.
- Merging identities across channels; email senders as a person key.
- An escalation-rule or workflow engine.
- Required-before-close attributes, dependent chains, macros.
- Multi-select, file and reference types.
- Value history beyond the last writer and the event stream.
- Classification inside the visitor's turn.
- Classification into a `sensitive` variable.
- Resolving `visitors`-row values into a turn.
- Renaming the `/context-variables` API.
- Backfilling classification over past conversations.

## 16. Open items

1. **WhatsApp data-subject finder.** It is absent on `main` independently of this work (`dataSubjectAccess.ts:26-30`). Slice 4 adds it; the product owner chose to ship it there rather than as a separate fix.
2. **Slice 4 decisions, confirmed in review.** (a) A routine's person save, customer scope included, records `context_value.changed` with the saving conversation as its subject and the scope but no person id; a value route write to a person scope records none. (b) `connector_whatsapp_conversations` records each conversation's number, beside the per-turn key, so the finder and readers outside a turn reach it; it reverses "nothing is stored" only for the WhatsApp plugin's own table, never the conversation row. (c) The backfill names each number's latest conversation only, so earlier conversations from before it stay unreachable by number; the operator docs say so. (d) `whatsapp_messages` exports a projection of the subject's own messages, never the stored webhook body.
