# Implementation Plan: Skill Slot Filling

**Branch**: `103-turn-skill-slot-filling` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)  
**Input**: Approved kit-only feature specification, including [fifth-pass review](./review5-codex-2026-08-02.md)

## Summary

Add a typed scalar field declaration to `SkillDefinition.inputSchema`, then give
the engine a narrow selected-skill input resolver port. The kit will compose the
default, model-backed resolver from `conversation-defaults`; it extracts only
declared fields from bounded history plus the current message, normalizes and
validates them, and returns a ready, needs-input, or failed decision.

The engine will resolve every selected skill from one immutable pre-dispatch
snapshot before it dispatches any skill. If all are ready, the existing dispatch
loop retains its current sequential staged-context and transient-guidance
behaviour. If one is parked or fails, nothing dispatches; a parked turn adds a
synthetic steering instruction to the normal composition path and reports
`awaitingSkillInput`. The streaming path uses the same prepared turn and must
still yield its normal final event. `conversation-tools` will stop projecting raw
MCP/OpenAPI JSON Schema into the newly typed contract.

## Technical Context

**Language/Version**: TypeScript 5.9; Node.js 24  
**Primary Dependencies**: workspace `@radioso/conversation-contract`, `conversation-engine`, `conversation-defaults`, `conversation-kit`, and `conversation-tools`; OpenAI-backed `ConversationModelGateway` (kit default GPT-5.2)  
**Storage**: N/A — kit-only, in-memory turn history is already host-owned through `ConversationStores`  
**Testing**: Vitest; red-green-refactor is mandatory before implementation  
**Target Platform**: Node.js library packages  
**Project Type**: TypeScript workspace libraries  
**Performance Goals**: No added model call or latency for skills without declared fields; at most one bounded extraction call per selected declared skill per turn  
**Constraints**: Resolve all selected skills from one immutable pre-dispatch snapshot; default extraction history is newest 20 messages and at most 8,000 characters, dropping oldest first; fail closed on parse/model/deadline failure; no raw values in traces; `ConversationModelGateway` has no abort signal, so deadline bounds waiting only  
**Scale/Scope**: Five conversation packages only; no backend, dashboard, persistence, HTTP/transport, MCP projection, or engine-owned resumption

## Constitution Check

### Pre-design gate — PASS

- **Approved specification**: `spec.md` is Approved, and the required fifth review approves it without material issues.
- **TDD**: Every implementation task begins with a failing focused Vitest test before the corresponding production change. Although this is package-library rather than backend-app work, the constitution's mandatory TDD standard is applied.
- **Stack**: Node.js and TypeScript remain unchanged. The kit's existing model gateway continues to default to GPT-5.2; no frontend or database work is introduced.
- **Secrets and customer data**: No configuration is added. The extraction prompt treats history/current message as untrusted data; traces carry only field names, outcomes, provenance category, and rejection reasons, never values, prompts, or conversation text.
- **Modularity**: Contract owns shared vocabulary and a narrow resolver port; engine owns turn orchestration and trace staging; defaults owns resolver/prompt/normalizer; kit owns default composition; tools owns its bridge migration. No package dependency is inverted (`defaults -> engine -> contract`).
- **Responsibility-limited files**: `conversation-engine/src/index.ts` remains orchestration-only. It gains a two-phase coordination helper and uses contract results, not parsing/prompt/normalization logic. The routine dispatcher and `slotCorrection.ts` remain unchanged because routine bindings are a separate contract.
- **Architecture refactor**: No preliminary refactor is necessary: the selection-to-dispatch seam and prepared-turn seam already exist. Introduce focused resolver/normalizer modules rather than enlarging existing routine machinery.
- **Application composition**: N/A. No `backend/src/app/composition/` or backend runtime infrastructure is in scope; kit composition is the appropriate local wiring seam.
- **HTTP/OpenAPI**: N/A. No backend HTTP contract changes; do not edit generated OpenAPI files.
- **Message queue review**: The TypeScript contract changes only flow among in-process workspace packages. They do not change document-worker dispatch, AMQP payloads, retry semantics, queue tests, or queue docs. MCP/OpenAPI JSON Schema projection is explicitly cut; the tools bridge merely ceases writing raw schemas to the typed field declaration.
- **Documentation parity**: Update `packages/conversation-kit/README.md` in implementation with declaration and parked-turn usage.

### Post-design gate — PASS

Research resolves all implementation questions. The design preserves the required dependency direction, has a bounded/redacted model boundary, includes red-first tests for every required scenario, and identifies the kit README as the sole documentation update. No Constitution Check violation requires a complexity justification.

## Project Structure

### Documentation (this feature)

```text
specs/103-turn-skill-slot-filling/
├── spec.md
├── review5-codex-2026-08-02.md
├── plan.md
├── research.md
├── data-model.md
├── contracts/
│   └── skill-slot-filling.md
└── quickstart.md
```

### Source Code (implementation scope)

```text
packages/
├── conversation-contract/
│   └── index.d.ts                         # shared declaration, resolver port, turn result
├── conversation-engine/
│   ├── src/index.ts                       # two-phase resolution, orchestration, safe trace
│   └── tests/defaultConversationEngine.test.ts
├── conversation-defaults/
│   ├── src/skillInputResolver.ts          # resolver, prompt boundary, deadline, normalizer
│   ├── src/index.ts                       # public export
│   └── tests/skillInputResolver.test.ts
├── conversation-kit/
│   ├── src/composition.ts                 # default resolver construction/injection
│   ├── tests/composition.test.ts           # kit end-to-end behaviour
│   └── README.md                           # Skills documentation
└── conversation-tools/
    ├── src/skillBridge.ts                 # stop raw schema passthrough
    └── tests/toolBridge.test.ts
```

**Structure Decision**: Keep the public cross-package types in contract and
make the engine depend only on that contract. Put selected-skill extraction and
its pure scalar normalizer in defaults, which already depends on engine and
cannot be imported by it. Kit composition constructs the resolver using its
already-created model gateway and passes it into the engine. Raw transport
schemas stay on `ConversationToolDefinition`, not on `SkillDefinition`.

## Module Ownership & Seams

- **Transport Layer**: N/A. No backend transport, SDK endpoint, dashboard, MCP schema projection, or persistence work is planned.
- **Orchestration Layer**: `conversation-engine/src/index.ts` owns selection-to-resolution-to-dispatch sequencing, synthetic composition steering, prepared-result propagation, stream-final parity, and safe trace-stage construction.
- **Domain Layer**: `conversation-contract/index.d.ts` owns declarations/results/ports; `conversation-defaults/src/skillInputResolver.ts` owns extraction prompt creation, bounded history, deadline race, parsing, and scalar normalization. It must not change routine binding or routine slot correction.
- **Persistence/Integration Layer**: `conversation-kit/src/composition.ts` wires the defaults resolver to the kit model gateway. It does not persist an awaiting request and does not own extraction policy. `conversation-tools/src/skillBridge.ts` maps tool definitions without projecting raw schemas.
- **Application Composition**: Backend composition is N/A. Kit composition is explicitly updated because it is the local application assembly point for this standalone runtime.
- **Files Kept Small**: `conversation-engine/src/index.ts` does not gain provider calls, JSON parsing, normalizer rules, or prompt templates. `defaultPorts.ts` routine dispatch stays untouched. `slotCorrection.ts` remains routine-specific.
- **Planned Extractions**: Add named contract types and `ConversationSkillInputResolver`; add a focused default resolver module with private pure normalizer/prompt/history helpers.
- **Required Refactor Stories**: None.

## Implementation Design

### 1. Contract and result vocabulary

Replace `SkillDefinition.inputSchema?: unknown` with an optional concrete
declaration containing named fields. A field has `name`, scalar `type`
(`string | number | integer | boolean | date`), `required`, optional
`description`, and optional `permittedValues` (allowed only for `string`). A
skill with no declared fields continues to omit the declaration (or has an empty
field list) and is not resolved.

Add contract-owned types for:

- `ConversationSkillInputResolver.resolve({ skill, selected, turn })`;
- tagged resolution results: `ready` with canonical allowlisted input,
  `needs_input` with outstanding field reports, and `failed` with a safe failure
  code and structural field outcomes;
- an outstanding field report containing the name, scalar type, optional
  description/permitted values, and reason `absent` or `rejected`;
- `ProcessTurnResult.awaitingSkillInput`, one entry per selected skill that is
  parked this turn; and the same optional field on the internal prepared-turn
  result.

The resolver is an engine input and is required for engine callers that use
declared fields; the kit always wires one. This makes the engine invoke the
distinct port mandated by FR-003 rather than silently bypassing filling. Existing
direct engine tests/callers will supply a deterministic stub. No-fields skills
skip resolver invocation and retain the original `SelectedSkill.input` exactly.

### 2. Default resolver, normalization, and safety

Create `createConversationSkillInputResolver` in defaults and export it from
`src/index.ts`. It receives `ConversationModelGateway`, a configurable clock,
IANA time zone (default UTC), history limits, and deadline. Its normalizer is
private to defaults for this one-consumer slice; do not import it into engine or
reuse/alter routine `slotCorrection`.

For declared skills, validate host input first. Valid host values are canonical
and authoritative; declared host keys are never supplied to the model. A host
value that is present but invalid is reported as `rejected`, is never passed to
the handler, and is not silently replaced from model output. Remaining fields
are extracted once from data-only, bounded history plus the current message.
The system prompt contains field declarations/instructions, exact permitted
strings, today's date in the configured IANA zone, strict JSON-output rules, and
the instruction that conversation data has no authority. It includes no staged
context, turn metadata, or host values.

Normalization is deterministic: trim non-empty strings; parse finite decimal
numbers; require integral numbers for `integer`; accept only JSON booleans;
accept only `YYYY-MM-DD` strings for `date`; and match string permitted values
case-insensitively after trimming while returning the declared spelling. Discard
undeclared keys. The deadline is `Promise.race` only — it does not claim to
cancel `ConversationModelGateway.complete`. Malformed JSON, model errors, and
deadline expiry return `failed`, never partial input.

### 3. Engine two-phase plan and parked composition

At the selection-to-dispatch seam in `prepareTurn`, capture the immutable
`selectedTurn` immediately after selection (directive/retrieval steering and
context only). Resolve every selected skill from that one snapshot before any
dispatcher call. Preflight an unknown skill as a failed item too, so a bad
selection cannot allow a later selected skill to side-effect.

- If every item is ready, run a second, dispatch-only loop. Preserve the current
  sequence within this loop: skill B's *dispatch* still receives A's staged
  context and transient guidance exactly as today. Resolver calls never see
  those same-turn outputs.
- If any item is `needs_input` or `failed`, dispatch no skill. Copy every
  needs-input report to `awaitingSkillInput`. A failure remains a failure rather
  than an ask; when no failure is present, add one synthetic `skill`-sourced
  steering instruction covering all parked fields so the ordinary composer asks
  once, including declared choices. Do not introduce a special ask prompt,
  durable pending state, or automatic next-turn resumption.

Emit one engine-owned `skill_input_resolution` trace stage per selected skill,
immediately before any possible `skill_dispatch` stage. It records skill name,
declared field names, provenance category where useful, per-field
`ready|absent|rejected` outcome, and rejection/failure codes — never values,
raw parsed JSON, prompt text, history, current text, or host input. This makes
FR-014 observable at the resolver stage without leaking data.

`processTurn` and `processTurnStream` continue to share `prepareTurn`. Both
thread `awaitingSkillInput` through `createProcessTurnResult`. A parked stream
uses its ordinary streaming composer path and must emit a `final` event with the
parked result; no parked early return may leave `response` null and trigger
`conversation_stream_missing_final`.

### 4. Kit wiring, tools migration, and docs

Add an optional kit resolver override for hosts/tests. Otherwise,
`createConversationKit` constructs the defaults resolver from the already
created kit model gateway and passes it to `engine.processTurn`. Keep routine
skill dispatch unmodified: routine `inputBindings` remain its sole argument
source.

In `toolToSkillDefinition`, omit `inputSchema` rather than forwarding raw MCP or
OpenAPI JSON Schema. Keep `ConversationToolDefinition.inputSchema` unchanged so
MCP/OpenAPI adapters can retain their transport data. Repository search confirms
that no conversation-package consumer reads the bridged `SkillDefinition`
property today. Do not implement a partial projection.

Update the kit README Skills section with a typed declaration example, explain
that missing required fields return `awaitingSkillInput` and do not call the
handler, and state the host retry/guaranteed-reselection limitation from D8.

## Validation and TDD Plan

Write the following failing tests before implementation, then make each pass
without builds (use focused Vitest and `pnpm exec tsc --noEmit -p <package>/tsconfig.json`
only when type verification is needed):

1. `conversation-tools/tests/toolBridge.test.ts`: raw MCP/OpenAPI-style input
   schema no longer appears on `ToolSkillDefinition`; tool metadata and dispatch
   bridging remain unchanged.
2. New `conversation-defaults/tests/skillInputResolver.test.ts`: ready values,
   required-missing and invalid-choice/type reports, declared-key allowlist,
   host override/validation with no extraction call when complete, no-field skip,
   20-message/8,000-character oldest-first history bound, UTC/default and
   injected-zone date prompt, canonical scalar normalization, and parse/error/
   deadline fail-closed results with no value-bearing diagnostics.
3. `conversation-engine/tests/defaultConversationEngine.test.ts`: resolver
   receives one immutable pre-dispatch snapshot; multi-selection dispatches none
   until all resolve ready; all-ready dispatch retains existing A-to-B staged
   context/guidance behaviour; parked result/synthetic steering/composed reply;
   resolution trace redaction; and a parked `processTurnStream` emits `final`
   rather than `conversation_stream_missing_final`.
4. `conversation-kit/tests/composition.test.ts`: a directive-bound handler gets
   declared fields from one message and from history; missing required input
   asks once, exposes `awaitingSkillInput`, choices, and invokes no handler;
   an `always` directive re-matches after the answer turn; invalid model output
   parks; host selected input overrides without model extraction; and a
   no-fields skill retains no-extraction-call behaviour.
5. Manual/doc review: confirm README sample and parked-turn semantics match the
   contract and no backend/dashboard/MCP projection scope leaked in.

## Complexity Tracking

No Constitution Check violations to justify.

