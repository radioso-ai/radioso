# Research: Skill Slot Filling

## Decision: Put shared declarations and the resolver port in conversation-contract

**Rationale**: The engine needs a narrow abstraction and must not import
defaults. Contract already owns `SkillDefinition`, `SelectedSkill`,
`ProcessTurnInput`, and `ProcessTurnResult`, so it is the only dependency-safe
home for scalar declarations, resolver outcomes, and `awaitingSkillInput`.

**Alternatives considered**: Put the port in defaults (would make engine depend
upward); put it in engine (would force defaults/kit to depend on engine-specific
vocabulary); reuse routine clarification (wrong state and value contract).

## Decision: Keep resolver and normalizer in conversation-defaults

**Rationale**: Defaults already depends on engine and contract; engine depends
only on contract. The existing `slotCorrection.ts` is engine-owned,
routine-specific, and lacks integer/permitted-value rules. A defaults-owned pure
normalizer supports the sole consumer without creating a dependency cycle.

**Alternatives considered**: Reuse `slotCorrection` (does not satisfy D9 and
mixes routine semantics); move a shared primitive into engine now (premature
second-consumer refactor); make `RoutineNextStepSelector` resolve skills (breaks
the distinct contracts).

## Decision: Resolve from one pre-dispatch snapshot, then dispatch in a second phase

**Rationale**: The engine's current loop mutates staged context and steering
after every dispatch. Resolving inside it would leak skill A output into B's
extraction and could side-effect A before B parks. Preflight all selected items
against immutable `selectedTurn`, then dispatch only when all are ready.

**Alternatives considered**: Sequential resolve-and-dispatch (violates D1);
remove current sequential dispatch context/guidance (unnecessary regression for
no-fields skills); use a durable parked-state machine (explicitly cut).

## Decision: Keep ordinary composition, including ordinary streaming composition

**Rationale**: A needs-input result is represented as synthetic steering and
`awaitingSkillInput`, not a new asking subsystem. `processTurn` and
`processTurnStream` already share preparation; the stream composer must provide
the final response event for a parked turn as it does for a normal turn.

**Alternatives considered**: Dedicated ask prompt (D3 excludes it); an early
stream return without final (causes `conversation_stream_missing_final`);
reuse `RoutineAwaitingDecision` (different authored-state contract).

## Decision: Host input is authoritative but still validated

**Rationale**: Host-supplied declared values are normalized by the same rules,
never exposed to extraction, and win when valid. Invalid provided values remain
rejected/pending rather than being sent through or silently replaced by the
model.

**Alternatives considered**: Trust host input unvalidated (violates FR-009);
show it to the model (violates D5); let extracted data replace invalid host data
(breaks provenance authority).

## Decision: Bound untrusted extraction data by both recency and characters

**Rationale**: Use the most recent 20 history messages, cap all selected history
at 8,000 characters, and drop oldest entries first. Add the current message once
outside that bounded history. This bounds model cost and instruction-injection
surface while allowing recent multi-turn facts.

**Alternatives considered**: Message count only (does not bound long messages);
character count only (can lose conversational recency); staged context or turn
metadata (explicitly excluded by D4).

## Decision: Normalize only D9 scalars and prompt relative dates

**Rationale**: The normalizer deterministically validates string, number,
integer, boolean, and absolute date values. The resolver receives a clock and
IANA zone (UTC default) and asks the model to turn relative dates into an
absolute `YYYY-MM-DD`; validation never guesses a locale or reference date.

**Alternatives considered**: Locale/relative parsing in code (not deterministic
from `TurnContext`); arrays/objects (explicitly cut); choices on all types
(unsettled comparison semantics; D9 permits string only).

## Decision: Fail closed by racing the provider call, not cancelling it

**Rationale**: `ConversationModelGateway.complete` exposes no abort signal. A
deadline race bounds the turn's wait and returns a failed resolution; no partial
input or dispatch is permitted.

**Alternatives considered**: Claim cancellation (unsupported); retry inside the
turn (contradicts D11's no automatic retry loop); treat provider failure as
missing input (would ask when no reliable extraction ran).

## Decision: Emit engine-owned structural trace data at skill_input_resolution

**Rationale**: The engine is where outcome sequencing is visible. One stage per
selected skill before dispatch can report names, outcome, provenance category,
and rejection reason without requiring trace consumers to parse defaults internals.

**Alternatives considered**: Put values in model metadata/trace (violates
FR-014); hide all outcomes (fails operator observability); trace only dispatch
(omits parked and failed resolution).

## Decision: Stop raw schema passthrough in conversation-tools

**Rationale**: `toolToSkillDefinition` is the only conversation-package producer
that forwards `ConversationToolDefinition.inputSchema` to `SkillDefinition`.
MCP and OpenAPI adapters can retain their raw schemas as transport data, but the
typed declaration must not receive an unprojected shape. No consumer reads the
bridged property today.

**Alternatives considered**: Partial automatic projection (explicitly cut and
unsafe); retain `unknown` (FR-001/FR-002 compile break); change backend/dashboard
transport schemas (out of scope).

## Decision: Queue and OpenAPI impact is none

**Rationale**: The change is constrained to in-process conversation packages.
There are no backend routes, workers, AMQP messages, SDK endpoints, or MCP schema
projection changes. Therefore document-worker dispatch, payloads, retry
semantics, queue tests, queue docs, code-first OpenAPI registry, and generated
files are unaffected.

**Alternatives considered**: Treat raw tool schemas as an MCP projection change
(D10 explicitly defers projection); extend into backend adoption (tracked by
#967/#968/#969 and explicitly cut).

