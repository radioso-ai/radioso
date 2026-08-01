# Review: 103 Turn Skill Slot Filling

## Verdict

Do not approve this draft. Its central webhook user story cannot run on the
current directive-bound turn path, and the proposed kit/backend boundary has
not named the seam that can carry a persisted field declaration into the engine.
US1 also cannot safely ship before validation, missing-input handling, and
idempotency are specified.

## 1. Factual errors in Context

1. **The webhook scenario is not a current turn capability.** Context and US1
   describe a webhook skill bound to a directive and dispatched in chat
   (`spec.md:16-21`, `49-57`). The provider explicitly registers only
   `external_mcp` for directive-bound turns:
   `backend/src/app/composition/builtIn/agentSkillTurnSkillProvider.ts:47-54`.
   Its comment says webhook action skills are excluded because their output
   produces a blank generic reply (`:47-52`). Therefore this is not merely a
   field-name lookup gap for webhooks; it first needs an action-turn result and
   renderer contract.

2. **“Gets a request with an empty body” is false for webhook definitions.** A
   webhook executor detects missing required exposed payload fields and returns
   `missing_input` before resolving a destination or constructing a request
   (`backend/src/modules/webhookSkills/executor/webhookSkillExecutor.ts:69-81`).
   It only builds the JSON body after that check (`:84-105`). An MCP tool can be
   invoked with an empty input object, but that is not the webhook behavior the
   Context uses as its motivating example.

3. **The stored webhook declaration does not have the proposed type/choices
   shape today.** `exposedPayload` currently permits exactly `description`,
   `slotBinding`, and `required` (`backend/src/modules/webhookSkills/domain.ts:22-28`),
   with `required` defaulting to true. The same is true for MCP exposed params
   except that they have no `required` field at all
   (`backend/src/modules/externalSkills/domain.ts:96-106`). The draft correctly
   says FR-001 adds fields, but the Context reads as if both existing
   declarations already form a sufficiently parallel field contract. They do
   not: requiredness has to be derived from the MCP tool schema or newly stored.

4. **The field declaration is not available at the runtime skill-definition
   boundary.** `runtimeSkillDefinitionForAgentSkill` constructs a definition
   from only the `AgentSkillSpine` and records agent id/kind metadata
   (`agentSkillTurnSkillProvider.ts:217-238`). `AgentSkillSpine` has only generic
   `config` and target fields, not webhook `exposedPayload` or MCP
   `exposedParams` (`backend/src/modules/agentSkills/domain.ts:20-32`). The
   transport executors re-query their own stored definitions by name later
   (`webhookSkillExecutor.ts:60-69`; `mcpSkillExecutor.ts:106-123`). So the
   assertion in `spec.md:23-26` is right that `SelectedSkill.input` is passed
   then discarded, but it omits the more fundamental fact: no selected runtime
   skill currently carries the declarations an extractor needs.

5. **The four-key-envelope diagnosis is accurate only for the currently
   turn-capable MCP path, not product-wide webhook dispatch.** The envelope is
   exactly `{query, message, pageContext, context}`
   (`agentSkillTurnSkillProvider.ts:139-144`), and MCP filters it through
   `slotBinding ?? paramName`, omitting `undefined`
   (`backend/src/modules/externalSkills/skillDefinitions/resolver.ts:44-53`).
   But the provider's direct dispatcher ignores `SelectedSkill.input` entirely
   (`backend/src/modules/chat/services/conversationEngineChatTurn.ts:159-166`; the
   stream path repeats this at `:242-249`), and webhooks do not enter this path.
   “Product-wide gap” overstates what exists today.

6. **The routine non-impact claim is supported.** This part is right. Routine
   dispatch resolves authored bindings (or existing routine variables) before
   executor dispatch (`backend/src/modules/routines/skillDispatcher.ts:173-200`),
   and `resolveSkillArguments` is only literal/variable/context lookup
   (`packages/conversation-defaults/src/skillArgumentResolver.ts:14-32`). Do not
   fold that path into turn extraction.

## 2. FR-013/014/015: the real boundary

The boundary is drawable, but not as “the backend only supplies data +
transport” without one new, explicit kit seam. The kit can own a normalized,
versioned `SkillInputContract` (fields, requiredness, type/enum, source policy),
prompt construction, structured-result parsing, normalization/validation, and a
pure decision such as `ready(input)` / `needs_input(fields)` / `failed(reason)`.
The backend must map persisted webhook and MCP records into that contract and
attach it to the runtime `SkillDefinition` **before selection/dispatch**.

Use `SkillDefinition.inputSchema` as that typed, normalized contract rather
than add a second parallel descriptor. It is already the only definition-level
input seam visible to `ConversationSkillSelector` and
`ConversationSkillDispatcher` (`packages/conversation-contract/index.d.ts:201-208,
533-539`). Give it a concrete discriminated type rather than `unknown`; do not
put transport-specific data in it.

The missing operational seam is a package-level `ConversationSkillInputResolver`
(or equivalent) called by `DefaultConversationEngine` after selection and before
dispatch. It receives `{ turn, skill, selected }`, uses
`ConversationModelGateway`, and returns the three outcomes above. The engine
already has the necessary ordering point: it has both `skill` and `selected` in
the loop at `packages/conversation-engine/src/index.ts:563-583`.

Do **not** implement this by having the backend dispatcher look up a definition
and fill it. That makes each transport own extraction/validation and violates
FR-013. Do **not** implement it in the selector either: the selector has
`SkillDefinition[]` and directive matches (`conversation-contract/index.d.ts:549-555`)
but must remain deterministic selection policy. The current directive selector
returns only a skill name and no input (`directiveBoundSkillSelector.ts:127-137`),
which is correct.

There are two unavoidable backend responsibilities that FR-014 currently
pretends away:

- A resolver/mapper that joins the generic `agent_skills` spine to the webhook
  or MCP definition repository before runtime registration. Today those records
  are separately persisted and loaded only inside transport executors.
- A renderer and persistence adapter for `needs_input`. The engine can decide it,
  but the backend owns the chat presentation, streaming bridge, and durable
  conversation state. This is host integration, not extraction mechanics.

Also preserve the existing transport mapping. The extractor returns canonical
field names; the webhook executor must still map `slotBinding ?? payloadKey`
to its outbound key (`webhookSkillExecutor.ts:131-147`), and the MCP resolver
must still map `slotBinding ?? paramName` (`resolver.ts:44-53`). Otherwise FR-009
quietly breaks authored aliases.

## 3. Missing production requirements

These are release blockers, not test polish.

- **Streaming:** Specify a stream-safe `needs_input` result. Both stream and
  non-stream dispatcher adapters currently ignore `selected` (`conversationEngineChatTurn.ts:159-166,
242-249`); the stream composer then unconditionally takes `outcomes[0]`
  (`:258-264`). A missing-input turn with no dispatched skill will throw or
  render nothing. Require one committed question, a final stream event, and
  persistence of exactly the same pending state as the non-stream path.

- **Multiple selected skills:** The contract permits `SelectedSkill[]`
  (`conversation-contract/index.d.ts:276-280`) and the engine dispatches every
  entry sequentially (`conversation-engine/src/index.ts:561-605`). “one model
  call per turn covering the selected skill's fields” is singular and
  underspecified. Require either (a) v1 rejects/serializes to one selected
  terminal action before extraction, or (b) a deterministic per-skill plan with
  all validation complete before *any* side effect. Do not extract skill A,
  fire it, then discover skill B is missing a required field.

- **Non-binding selection:** Extraction must be keyed by the selected runtime
  skill contract, not by directive-binding metadata. `ChatTurnSkillSelector`
  can select a forced skill with reason `forced_turn_skill` and no binding
  metadata (`backend/src/modules/chat/services/turnSkillSelector.ts:168-177`).
  A metadata/host override must still receive exactly the same input contract,
  extraction, validation, and block-before-fire behavior.

- **Extraction failure and timeout:** Add a bounded timeout, cancellation,
  retry policy, and explicit fail-closed outcome. The model port only exposes
  `complete(...)` (`conversation-contract/index.d.ts:423-429`); the current
  turn cancellation check happens before executor dispatch
  (`agentSkillTurnSkillProvider.ts:258-281`), not around a hypothetical
  extractor. On parse failure, timeout, model outage, or cancellation, no
  outbound call may occur. The visitor-facing fallback and trace status must be
  specified without logging extracted values.

- **Prompt injection and data minimization:** Visitor text is untrusted and the
  result becomes an outbound HTTP/MCP body. Require schema-constrained output,
  explicit instruction/data delimiters, no model authority to add keys or alter
  bound values, and an allowlisted input view. Never place the whole
  `context` envelope in the extraction prompt by default: it is
  `session.resolvedContext.snapshot` (`agentSkillTurnSkillProvider.ts:139-144`),
  and FR-005 currently does not define a safe context-field reference. Invalid,
  coerced, or injection-shaped data must be treated as missing, not silently
  sent. JSON serialization is not a substitute for semantic authorization.

- **Idempotency:** Add a turn/action idempotency requirement before enabling
  webhook turns. The webhook executor uses an explicit key only if context
  supplies `idempotencyKey` or `requestId`; otherwise it falls back to
  `routine-skill:<session>:<routine>:<step>:<skill>`
  (`webhookSkillExecutor.ts:166-172`). The current direct turn context supplies
  `messageId` but neither of those keys (`agentSkillTurnSkillProvider.ts:260-279`).
  A direct webhook turn would therefore share the same fallback key across all
  turns in a conversation. Require a stable key derived from message/turn id
  plus skill identity, persisted before dispatch, and define whether retries
  reuse it. This must cover retry-after-unknown-delivery without double firing.

- **Versioning and drift:** Store an input-contract version/snapshot with the
  pending ask. Otherwise an author can change fields/choices after the question
  is asked and the reply will be interpreted under a different contract.

- **Authorization and observability:** Require capability checks before model
  extraction (do not spend model tokens for a denied side effect), and a
  redacted trace/audit record for extraction status, model failure, chosen skill,
  contract version, and idempotency key fingerprint. FR-010 says not to log
  values, but it has no audit/event requirement for an action that was blocked
  or subsequently fired.

## 4. US2: ask instead of fire

Reuse the *question rendering capability*, not the existing clarification
workflow. Missing fields are a different outcome.

The existing `ConversationClarifier` asks a question over
`ClarificationCandidate[]` and maps the next reply to a candidate `id`,
`declined`, or `unrelated` (`conversation-contract/index.d.ts:431-442,
511-530`). `PendingClarification` likewise stores a list of mutually exclusive
candidates (`:476-500`). That is right for routine activation: the activator can
return `{ kind: "clarify", candidates }` (`:1068-1083`), and the engine persists
it with source `routine_activation` (`conversation-engine/src/index.ts:855-894`).

A required `calendar_date` is not a choice between candidates. The next reply
is arbitrary data that must be extracted, validated, associated with a selected
skill and contract version, and may contain several fields. Encoding requested
fields as `ClarificationCandidate`s would make `mapReply` choose an option id,
not recover the supplied values; it also conflates “which routine?” with “what
value?”.

Add a first-class `needs_skill_input`/`awaiting_skill_input` turn outcome and a
durable pending-skill-input record (it may share the storage table and expiry
machinery, but must have its own discriminated payload and resolver). It may use
`ConversationClarifier.phraseQuestion` only after that port is widened to phrase
field requests; it must not use `mapReply` as the value resolver. On the next
turn, reload the exact selected skill + contract snapshot, re-run the extractor
against the reply, and only then allow transport. This also makes the
single-coherent-question requirement feasible.

## 5. Sequencing

US1 is **not independently shippable** without US3. FR-001 introduces types and
choices, and US1's own first scenario promises the optional field is one of
those choices (`spec.md:61-64`). Sending an unvalidated model value to an
outbound action is the unsafe behavior US2 is supposed to prevent. Validation,
fail-closed extraction error handling, and idempotency belong in the P1 vertical
slice with the first transport. US3 should be P1, not P2.

US2 is also inseparable from US1 for every required field. The real first slice
is: normalized contract -> extraction -> validation -> `needs_skill_input`
durable flow -> idempotent dispatch -> non-stream and stream rendering. US4 is
not a prerequisite.

## 6. Decisions for the open questions

1. **Use `SkillDefinition.inputSchema` for the normalized, versioned shared
   field descriptor; do not add a sibling field.** It is already the only
   definition-level input seam both selector and dispatcher receive, while its
   current `unknown` type is intentionally empty (`conversation-contract/index.d.ts:201-208`).

2. **Make missing required input a first-class `awaiting_skill_input` outcome,
   not a clarification.** `ClarificationCandidate` and
   `ClarificationReplyMapping` model choosing an opaque alternative, not
   capturing and validating arbitrary field values.

3. **Put coercion/normalization in the extractor and pass canonical typed
   values to transport.** One shared semantic contract prevents webhook and MCP
   from diverging on dates, numbers, enums, and null/absence.

4. **Do not auto-project MCP JSON Schema in this slice.** Schema projection is a
   separate compatibility/versioning problem; require the normalized descriptor
   explicitly for the first supported turn transport, then add a tested MCP
   projection later.

5. **Include a minimal dashboard editor for type and permitted values in this
   slice.** The draft says dashboard authors own these declarations; an API-only
   field contract would leave the principal product surface unable to configure
   the feature. Keep it to type/enum/required/description, not advanced source
   policies.

## 7. Scope to cut from the first slice

- Cut US4's visitor-vs-context source-policy system. Start with a strict rule:
  model extraction uses conversation text only; author-fixed values remain
  `boundPayload`/`boundParams`; no arbitrary resolved context is exposed. A
  later slice can add named, allowlisted context refs.
- Cut automatic MCP JSON Schema projection. Do not promise that every discovered
  tool becomes fillable.
- Cut broad coercion ambitions. Start with explicitly modeled scalar fields and
  closed enums with fail-closed parsing; add complex objects/arrays, locale date
  interpretation, and lossy coercions only with their own contract/tests.
- Cut the claim that webhook is the first vertical slice unless the team also
  budgets action-turn rendering and direct-turn idempotency. The currently
  directive-bindable transport is `external_mcp`; alternatively make the first
  webhook slice routine-only, where dispatch and idempotency semantics already
  exist, but that would not satisfy the stated turn feature.

What must *not* be cut is validation, durable missing-input state, stream
parity, and idempotency. They are the minimum safety boundary for letting an
LLM-derived value trigger an outbound side effect.
