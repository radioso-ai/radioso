# Feature Specification: Conversational Directives — Authored Standing Steering Matched Per Turn

**Feature Branch**: `067-conversational-directives`
**Created**: 2026-05-29
**Status**: Draft
**Input**: Architecture follow-on to the assistant-as-spine direction (issue #465 / spec `066`). Introduces the behavioral-steering layer the spine selects per turn, distinct from capabilities.

**Scope Note**: This spec introduces a **Directive**: an authored, standing `condition → action` steering rule that the assistant turn loop **matches** per turn and **injects into answer composition** to shape *how* the agent behaves — including whether it reaches for a skill. A Directive is the standing, named counterpart of the per-turn `SkillTransientGuidance` a skill outcome already injects today; both are unified behind a single `SteeringRule` value type that feeds one compose-time steering set. The deliverable is: the shared `SteeringRule` extraction, the Directive catalog + per-turn **matcher port**, a deterministic always-match matcher, and compose-time injection — with a probabilistic (LLM) matcher, directive relationships, and skill-selection biasing as later slices.

This spec does **not** give Directives an executor, a dispatch path, or any ability to *act* — Directives steer; Skills act. It does **not** build a visual/operator rule editor, persist a directive store schema in v1 (the standing set is composition-resolved), or change the skill-invocation port. It does **not** introduce a new steering vocabulary parallel to the existing one. Those are explicit anti-goals.

**Relationship to `066` (not a blocking dependency)**: The core of this spec — authored Directives steering composition — rides on **today's** answer composer (`ChatService.composeGroundedSystemPrompt`, which assembles `baseSystemPrompt` + an envelope block), not on the `066` gather→select→dispatch spine. It does **not** require `065` (retrieval-as-skill) or the `066` loop. Note that `SkillOutcome.guidance` (defined in `066`) is **consumed by no runtime code today** — there is no existing steering sink to generalize; this spec *creates* the steering-into-prompt injection. Two later slices converge with `066` once its loop lands and actually consumes skill outcomes: merging skill-emitted `guidance` into the same `SteeringRule[]`, and letting matched Directives bias *skill selection*. Those are additive, not gating.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Steer Behavior Without Adding A Capability (Priority: P1)

As a developer shaping an agent's behavior, I want to add a behavioral rule — "when the customer sounds anxious, slow down and confirm before acting" — by registering a Directive, so that the agent's *conduct* changes **without** adding a skill, threading code through the turn loop, or editing any skill.

**Why this priority**: This is the architectural reason the feature exists. Today the only unit the spine selects is a Skill (a capability). Behavioral rules have no home except a monolithic prompt — the exact thing the assistant-as-spine model exists to escape. The proof the layer works is that conduct changes arrive as a registration, not as prompt edits or loop branches.

**Independent Test**: Register a throwaway always-match Directive whose `action` is a distinctive instruction. Submit an assistant turn. Assert that (a) the directive was matched and recorded in the turn's activity trace, (b) its `action` reached the answer-composition context, and (c) no skill catalog entry, executor, or skill-selection branch was added to make it work.

**Acceptance Scenarios**:

1. **Given** a registered Directive in the agent's standing set whose condition holds this turn, **When** the agent composes a response, **Then** the directive's `action` is present in the compose steering set and the match is recorded in the activity trace with a selection mode and reason.
2. **Given** the same Directive, **When** I inspect the wiring, **Then** the only places that reference it are its catalog entry and its registration in composition; the turn loop and the skills/retrieval modules contain no directive-specific branches.
3. **Given** a Directive declaring `requiredCapabilities` the agent lacks, **When** a turn would otherwise match it, **Then** it is not injected, and the omission is recorded.

---

### User Story 2 - A Directive Steers, It Never Acts (Priority: P1)

As a maintainer, I want a Directive to be structurally incapable of *doing* anything — no dispatch, no executor, no outputs — so that the Skill/Directive boundary cannot erode into "a Directive is a weird Skill."

**Why this priority**: The value of the two-unit model collapses if Directives grow execution. A Directive that can act is a malformed Skill, and the catalog stops meaning anything. The boundary must be enforced by type, not discipline.

**Independent Test**: Inspect the Directive type and the directives module's public surface; assert there is no `dispatch`, executor port, or outputs channel on a Directive, and that the directives module does not import the skills executor registry or the retrieval module.

**Acceptance Scenarios**:

1. **Given** the Directive contract, **When** its type is inspected, **Then** it carries `condition`/`action` and steering metadata only — no execution descriptor, no executor, no result channel.
2. **Given** the directives module, **When** its dependency graph is inspected, **Then** it depends on no other domain module (not skills, not retrieval, not chat); chat depends on it through a catalog + matcher port.

---

### User Story 3 - Authored And Skill-Emitted Steering Are One Type (Priority: P1)

As an architect, I want a Directive (authored, standing) and a `SkillTransientGuidance` (skill-emitted, single-turn) to be the **same value type** flowing into the **same compose-time steering set**, so the composer consumes one steering channel rather than two parallel vocabularies.

**Why this priority**: A standing rule and a skill-injected rule are the same shape — `condition → action` with priority/criticality — differing only in lifespan and source. Modeling them twice guarantees drift and two prompt-injection paths. Unifying them now is the difference between an extension of the existing substrate and a second architecture.

**Independent Test**: Assert that the type the answer composer reads for steering is a single `SteeringRule[]`, that both a matched Directive and a skill-emitted guidance map into it, and that `SkillTransientGuidance` is defined as (or aliased to) that shared type with no field divergence.

**Acceptance Scenarios**:

1. **Given** a turn that matches one standing Directive and dispatches a skill that emits one transient guidance, **When** the composer runs, **Then** both appear in a single ordered `SteeringRule[]`, each tagged with its source (`directive` | `skill`) and lifespan.
2. **Given** the shared type, **When** `SkillTransientGuidance` is inspected, **Then** it is the same shape as a Directive's steering payload (no field drift), and the existing skill-emitted guidance path is behavior-preserved.

---

### Edge Cases

- What happens when no Directive matches a turn? The composer runs with an empty (or skill-only) steering set; behavior is the agent's default. No error.
- What happens when two matched Directives conflict (e.g. "be concise" vs. "explain in depth")? v1 orders by `priority` then `criticality` and passes both to the composer as ordered steering; deterministic *resolution* of conflicts (exclusion) is a later slice (relationships). The ordering MUST be defined, not incidental.
- What happens when a contextual condition's match is uncertain? The probabilistic matcher returns a `selectionConfidence`; v1 includes the match above a composition-configured threshold and records the confidence. The threshold is settings/composition-owned, never a code constant tuned per phrase.
- What happens when the standing directive set is large? Matching MUST scale by narrowing (relationships slice); v1 with a small always-match set does not exercise this, but the matcher port MUST NOT assume the full set is always injected.
- What happens when a Directive's `action` would author user-facing copy directly? It MUST NOT. The `action` is *instruction to the composer*, consumed by the LLM/canned path; it is not literal assistant copy. Multilingual rendering stays owned by the compose path.
- What happens when a matched Directive biases skill selection but the selector chooses otherwise? The bias is a soft signal, not a command; the selector's structured decision is authoritative and records that the signal was considered.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js and TypeScript.
- Database MUST be PostgreSQL with `pgvector`. v1 introduces no new storage system and no directive table; the per-agent standing set is resolved at composition.
- Backend development MUST follow TDD: tests written and failing before implementation, including the `SteeringRule` unification assertion and the directive-has-no-executor type guard.
- Customer data MUST be protected with least-privilege access. A Directive declaring `requiredCapabilities` the agent lacks MUST NOT be injected, honoring the existing capability model.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, persistence, and replaceable runtime adapters. The directives module owns the Directive contract, the catalog, and the matcher port; it MUST NOT depend on chat, skills, or retrieval.
- Application composition owns replaceable runtime wiring: the per-agent standing directive set and the matcher implementation MUST be assembled under `backend/src/app/composition/`, beside the `066` orchestration strategy.
- Runtime LLM prompt templates MUST live under `backend/prompts/`. The probabilistic matcher's prompt MUST live there and return a **structured** matched-id decision; directive conditions MUST NOT be encoded as English keyword lists or regexes (Radioso is multilingual — a condition is an LLM-matched natural-language clause or a structured `always`).
- User-facing assistant copy MUST come from the LLM. A Directive's `action` is composer instruction, never literal assistant copy; no hard-coded conversational responses.
- Public/SDK/MCP/worker contract changes MUST include a message-queue impact review. v1 changes no public contract and no worker payload; the `SteeringRule` extraction is internal. The review MUST confirm this and update queue docs/tests only if the extraction touches an exported shape.
- Documentation MUST be updated to describe Directives, the Skill/Directive distinction (act vs. steer), and how a Directive is registered and matched.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The chat module owns the **turn loop / spine**: it asks the matcher which Directives hold, hands matches to skill selection as signals, and merges matched Directives with skill-emitted guidance into the compose steering set. It MUST NOT own directive matching logic, condition evaluation, or the standing set's contents.
- **Encapsulation Rule**: The directives module owns the **Directive contract, the directive catalog, and the matcher port**. The matcher *implementation* (deterministic and, later, the LLM-backed one) is registered at composition. A Directive has **no executor** and **no dispatch**.
- **Dependency Direction Rule**: `chat → directives (catalog + matcher port)`, identical to `chat → skills`. The directives module depends on no other domain module. Skill selection consumes matched Directives as input (`skill selector ← directive matches`); a Directive MUST NOT reference, import, or name a skill executor — any skill affordance (later slice) is read *by the selector*, never executed by the Directive.
- **Steer-Not-Act Rule (the boundary that must not erode)**: A Directive is matched and injected into compose context; it never acts, dispatches, or returns outputs. The moment a Directive gains a `dispatch()` it is a malformed Skill. This MUST be enforced by the type (no executor field, no result channel), not by convention.
- **One-Steering-Vocabulary Rule**: A matched Directive and a skill-emitted `SkillTransientGuidance` MUST be the same value type (`SteeringRule`) flowing into one ordered compose steering set. The existing `SkillTransientGuidance` MUST be redefined as (or aliased to) the shared type with no field divergence. The composer MUST NOT grow a second steering input.
- **Selection-Is-Auditable Rule**: Every Directive match MUST carry a `selectionMode` (`deterministic` | `probabilistic`, reusing the `SkillDiagnostic` vocabulary), a `selectionReason`, and an optional `selectionConfidence`, and MUST be recorded in the turn's activity trace with parity to how skill selection is traced.
- **Source-Of-Truth Rule**: The matched, ordered steering set for a turn is assembled by the loop at compose time from (standing matched Directives + skill-emitted transient guidance). It is not persisted as a separate record in v1; the activity trace is the observable record of what steered the turn.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A **Directive** MUST be an authored declarative unit carrying a `condition`, an `action`, and steering metadata (`priority`, `criticality`, optional `requiredCapabilities`, optional `description`). It MUST carry no execution descriptor, no executor, and no result/output channel.
- **FR-002**: A Directive `condition` MUST be either `{ kind: "always" }` (deterministic; resolved with no model call) or `{ kind: "contextual"; description }` (probabilistic; matched by the LLM matcher). It MUST NOT be expressible as an English keyword list or regex.
- **FR-003**: The directives module MUST expose a **catalog** (the registered Directive definitions) and a **matcher port** `match(turnContext, directives) => DirectiveMatch[]`. The matcher port MUST NOT assume the entire standing set is always returned (it MUST permit narrowing).
- **FR-004**: A `DirectiveMatch` MUST carry the matched Directive, a `selectionMode` (`deterministic` | `probabilistic`), a `selectionReason`, and an optional `selectionConfidence`.
- **FR-005**: A shared `SteeringRule` value type MUST be introduced. The existing `SkillTransientGuidance` MUST be redefined as (or aliased to) it with no field divergence. Both a matched Directive and a skill-emitted guidance MUST map into a single ordered `SteeringRule[]` consumed by the answer composer, each tagged with its `source` (`directive` | `skill`) and `lifespan`.
- **FR-006**: The chat turn MUST, per turn: (a) call the matcher for the agent's standing set and (b) render the matched Directives' `action`s into the answer-composition system prompt as an ordered `SteeringRule[]` (ordered by `priority` then `criticality`), at today's compose point (`composeGroundedSystemPrompt`). The compose path MUST contain no directive-specific branches — it consumes a `SteeringRule[]`, not Directives. Merging *skill-emitted* guidance into the same set and passing matches to *skill selection* as signals are deferred to the `066`-dependent slices (3–4); v1 injects directive-sourced steering only.
- **FR-007**: A Directive whose `requiredCapabilities` the agent does not hold MUST NOT be injected, and the omission MUST be recorded.
- **FR-008**: Adding a Directive MUST require only (a) a catalog entry and (b) inclusion in the agent's composition-resolved standing set. It MUST require **no** changes to the skills or retrieval modules and **no** branches in the turn loop.
- **FR-009**: The deterministic `always` matcher MUST resolve without a model call. The probabilistic matcher (later slice) MUST use a prompt under `backend/prompts/` returning a structured matched-id decision, and MUST honor a composition/settings-owned confidence threshold — never a per-phrase code constant.
- **FR-010**: Every Directive match (and capability-based omission) MUST be recorded in the turn's activity trace with `selectionMode`/`selectionReason`/`selectionConfidence`, with parity to skill-selection tracing.
- **FR-011**: Skill selection MUST be able to read matched Directives as soft signals. A Directive MUST NOT name or import a skill; the selector's structured decision is authoritative and MUST record that a directive signal was considered.
- **FR-012**: Documentation MUST describe (a) what a Directive is, (b) the Skill/Directive distinction (act vs. steer), (c) how a Directive is registered and matched, and (d) that authored Directives and skill-emitted guidance share one steering type.

### Key Entities *(include if feature involves data)*

- **Directive (catalog entry)** — authored standing `condition → action` rule with `priority`/`criticality`/`requiredCapabilities`/`description`. No execution, no executor, no outputs. New type introduced by this spec.
- **Directive Condition** — `{ kind: "always" }` (deterministic) or `{ kind: "contextual"; description }` (LLM-matched). Natural-language or structured; never a keyword list.
- **Directive Match** — the matcher's per-turn result: the matched Directive plus `selectionMode`/`selectionReason`/`selectionConfidence`. New type.
- **SteeringRule** — the shared value type unifying a matched Directive's steering payload and a skill-emitted `SkillTransientGuidance`: `action`, optional `condition`, `priority`, `criticality`, `description`, plus `source` (`directive` | `skill`) and `lifespan` (`response` | `session`). `SkillTransientGuidance` is redefined as/aliased to this.
- **Standing Directive Set (per-agent)** — resolved at composition; the Directives in scope for an agent. No persisted entity in v1.
- **Activity trace** — existing per-turn trace; gains directive match/omission records beside skill-selection records.

## Data Model Direction

This spec introduces **no new tables** and **no new persistence**. The per-agent standing directive set is composition-resolved (a code-registered set, like the default skill catalog and the `066` orchestration strategy). If a future spec lets operators author Directives at runtime, a directive table keyed by agent/workspace would be added then — explicitly out of scope here. The activity trace remains the observable record of what steered a turn.

## API Direction

No new public REST endpoints and no public contract change in v1. The `SteeringRule` extraction is internal to the backend; the answer-composition steering input changes shape internally but is not public API. The matched-directive records in the activity trace surface through the existing trace channel. The probabilistic-matcher prompt is a runtime template under `backend/prompts/`. SDK/MCP/worker contracts are unaffected; the message-queue review MUST confirm this.

## Delivery Split

Suggested slices, each independently shippable and behavior-preserving where possible:

1. **`SteeringRule` extraction + Directive contract + always-match matcher + compose injection — standalone on today's composer, no `066` dependency.** Extract the shared type from `SkillTransientGuidance` (behavior-preserving), add the Directive contract and directives module (catalog + matcher port), ship a deterministic `always` matcher, render matched Directives into the system prompt at `composeGroundedSystemPrompt`, and resolve the per-agent standing set at composition. No LLM matching, no skill-side merge yet.
2. **Probabilistic matcher.** LLM condition matching, prompt under `backend/prompts/`, structured matched-id output, composition-owned confidence threshold, `selectionMode: probabilistic` in the trace. Still standalone.
3. **Skill-guidance convergence (rides on `066`).** Once the `066` loop dispatches skills and consumes their outcomes, merge skill-emitted `SkillOutcome.guidance` into the same `SteeringRule[]` the composer already reads — the two sources unify on one sink.
4. **Skill-selection biasing (rides on `066`).** Matched Directives flow into the `066` skill selector as soft signals; the selector records that they were considered.
5. **Relationships (exclude / dependsOn).** Directive-to-directive dependency and exclusion to keep the matched set narrow as the standing set grows — the lever that lets many Directives coexist without degrading the prompt. Independent of `066`; sequence after slice 2.

## Assumptions

- Slices 1–2 and 5 stand alone on today's composer and do **not** wait on `066` or `065`. Only slices 3–4 (skill-guidance convergence, skill-selection biasing) ride on the `066` loop once it consumes skill outcomes.
- `SkillOutcome.guidance` is currently consumed by no runtime code; v1 creates the steering-into-prompt injection rather than generalizing an existing sink. When `066`'s loop later consumes outcomes, skill-emitted guidance joins the *same* `SteeringRule[]` (slice 3) — one sink, two sources.
- A composition-resolved standing directive set and a small always-match set are acceptable for v1; runtime-authored Directives and a persisted store are later work.
- The existing activity trace channel is sufficient to record directive matches; no new transport is required.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new Directive can change the agent's conduct by adding one catalog entry and including it in the composition-resolved standing set, with **zero** changes to files under `backend/src/modules/skills/` or `backend/src/modules/retrieval/` and **zero** directive-specific branches in the turn loop (verified by diff inspection in the User Story 1 test).
- **SC-002**: The Directive type contains no executor, no `dispatch`, and no outputs channel, and the directives module imports neither the skills executor registry nor the retrieval module (verified by static check — the Steer-Not-Act rule).
- **SC-003**: `SkillTransientGuidance` and a matched Directive's steering payload are the same `SteeringRule` type with no field divergence, and the answer composer reads exactly one ordered `SteeringRule[]` (verified by type assertion and a single-sink test).
- **SC-004**: Every Directive match and capability-based omission appears in the turn's activity trace with `selectionMode`/`selectionReason`, at parity with skill-selection tracing (verified by trace inspection).
- **SC-005**: Directive conditions contain no English keyword lists or regexes; contextual matching is an LLM-returned structured decision driven by a prompt under `backend/prompts/` (verified by review against the no-keyword-lists rule).
- **SC-006**: Docs describe the Directive, the act-vs-steer distinction, registration/matching, and the shared steering type.
