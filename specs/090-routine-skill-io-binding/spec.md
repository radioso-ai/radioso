# Feature Specification: Routine ↔ Skill I/O Binding

**Feature Branch**: `090-routine-skill-io-binding`
**Created**: 2026-06-16
**Status**: Draft (for discussion)
**Input**: User description: "Skills expose input and output variables. Routines currently don't see them. Make routines able to see a skill's inputs/outputs and supply values — supporting both a typed mode (assign values to a skill's inputs) and an untyped mode (let the agent pick a skill from a scoped menu and fill it conversationally)."

## Design Context *(why this exists)*

Today a routine step references a skill by an **opaque name string** (`toolRef`). The mapping from collected routine slots to a skill's inputs lives entirely on the *skill definition* (`exposedParams` / `slotBinding`), configured in a separate settings screen and connected only by string name-matching. The routine never sees the skill's input or output schema; nothing validates that a referenced skill exists for the agent or that its required inputs are collected. Runtime dispatch works, but only through a fragile two-place convention with no schema visibility.

This feature gives authors **both** a deterministic typed path and an agentic untyped path, over one shared substrate: the routine's variable namespace plus each skill's input/output schema surfaced to the authoring layer. Both modes live in a **popover on the skill chip** (there is no skill editor today); mode is a toggle there, not two step kinds; the default is typed with empty ports.

### The variable model (load-bearing)

A routine already has a runtime **`variables`** map — today it holds the slots captured by chat collection steps, keyed by slot key, and is what `{{n<key>}}` interpolation and field guards read (`routineRunner.ts`). This feature makes that namespace the explicit substrate and adds skill outputs to it:

- **Variable sources**: (a) **collection-step slots** (`routine_slot`: typed `text|number|boolean|email|date`, named, required) gathered from the customer — unchanged; (b) **skill-output assignments** — a typed skill step maps a chosen skill output field to a named variable, written into `variables` at dispatch.
- **Referenced by**: skill inputs (this spec), `{{n<key>}}` interpolation, and field guards — uniformly, as "variable X." (Field guards today read skill `outputs` then `variables`; output assignment unifies these so a guard can reference the assigned variable directly, with the existing `outputs`-first fallback preserved.)
- **Naming**: variable names are unique within a routine across both sources; collisions are flagged.

A skill input binds to **either a typed literal or a variable reference** — nothing else (no expression language; constants need not be promoted to variables). Because a binding just points at a variable, the author is never asked "where does this value come from?" — provenance is wherever the variable was set.

### No typed runtime gaps; collection is explicit (resolves the typed/runtime tension)

**Typed mode has no runtime input gaps.** A required typed input must resolve at publish time to a literal or a **guaranteed-populated** variable (validation, R5/R7). To source a typed input from the customer, the author places a collection step upstream that populates the variable — the existing routine mechanism. Runtime input *collection* therefore happens in exactly two places: **collection steps** and **untyped fill**. This is the in-routine step-input collection that spec 085 explicitly deferred (085 suppresses asks while a routine is active); 090 owns it, using the routine's own slot-collection machinery — **not** the 085 Clarifier.

## User Scenarios & Testing *(mandatory)*

Stories are independently shippable. US1 is the foundation; US2/US3 are the two modes; US4 is channel-aware collection (needed for email viability).

### User Story 1 - See a skill's inputs and outputs while authoring (Priority: P1)

When authoring a routine, the author can see — for every skill available to the agent — the skill's input variables (name, type, required) and its output variables/outcomes, without leaving the routine editor. A routine that references an unknown skill, or reaches a skill with a required input nothing can satisfy, is flagged at author/validate time rather than failing silently at runtime.

**Why this priority**: Closes the "routines are blind to skills" gap and is the prerequisite both modes build on; delivers value alone.

**Independent Test**: Against an agent with retrieval, one external/MCP skill, and one email skill, open the routine editor and confirm each skill's input variables (typed) and output descriptor (data fields when present; outcomes always) are listed. Author a routine referencing a non-existent skill and one whose required input is unsatisfiable; confirm both produce diagnostics and block publish.

**Acceptance Scenarios**:

1. **Given** an agent with defined skills, **When** the author opens a skill chip's popover, **Then** the editor shows that skill's input variables (key, type, required) and its output descriptor (data fields and/or outcomes).
2. **Given** a skill step naming a skill not available to the agent, **When** validated, **Then** a diagnostic flags it and publish is blocked.
3. **Given** a skill step with a required input that is neither bound nor eligible for fill, **When** validated, **Then** a diagnostic flags the unsatisfiable required input.
4. **Given** any skill kind behind the skill port (retrieval, external/MCP, customer-email), **When** the catalog is shown, **Then** all kinds are represented uniformly via the normalized descriptor (see Skill I/O Descriptor Contract).

---

### User Story 2 - Typed binding: bind inputs to literals or variables (Priority: P2)

In the skill chip's popover the input ports are shown; the author binds each to a typed literal or a variable reference, and assigns skill output fields to named variables for downstream use. At runtime the step dispatches deterministically. Required inputs must resolve to a literal or a guaranteed-populated variable, with compatible types, or the routine does not validate.

**Why this priority**: The precision affordance and the real fix for the two-place `slotBinding` fragility. Preserves deterministic runtime.

**Independent Test**: Bind one input to a literal and one to a variable collected upstream, assign an output to a variable; run and confirm the skill dispatches with exactly those values, no LLM fill pass occurs, and a later step references the output variable. Leave a required input unbound and confirm validation blocks publish.

**Acceptance Scenarios**:

1. **Given** a skill step popover, **When** the author opens its inputs, **Then** each input can be bound to a typed literal or a variable reference — and nothing else.
2. **Given** all required inputs resolve to a literal or guaranteed-populated variable, **When** the step runs, **Then** the skill dispatches with the resolved values and the turn invokes no LLM argument-fill pass.
3. **Given** a required input is unbound or bound to a not-guaranteed-populated variable, **When** validated, **Then** a diagnostic blocks publish.
4. **Given** a binding whose type is incompatible with the input's declared type, **When** validated, **Then** a diagnostic flags the mismatch.
5. **Given** a skill step assigns an output field to a named variable, **When** a later step references that variable (binding or field guard), **Then** it resolves to the produced value.
6. **Given** bindings and output assignments authored on the routine, **When** exported/imported (079/082), **Then** they travel with it.

---

### User Story 3 - Untyped: let the agent choose and fill from a scoped menu (Priority: P3)

A skill step toggled to untyped offers an author-scoped per-step candidate set. The agent chooses which to invoke and fills the chosen skill's inputs from conversation context against its input schema. Missing required inputs trigger routine input collection (US4), not a guessed or failed call. No static binding is authored.

**Why this priority**: The agentic affordance; additive to US1.

**Independent Test**: Configure two candidate skills; drive an intent selecting A and confirm it is called with context-filled inputs; drive a missing-required case and confirm collection is triggered, not a failed call.

**Acceptance Scenarios**:

1. **Given** an untyped step scoped to a candidate set, **When** the turn runs, **Then** the agent may select one candidate skill and fill its inputs from context.
2. **Given** a required input cannot be filled from context, **When** the agent would otherwise call, **Then** routine input collection is triggered.
3. **Given** a candidate skill is gated by a capability the agent lacks, **When** selection runs, **Then** it is not offered/dispatched (same gates as typed dispatch).
4. **Given** a routine mixes typed and untyped steps, **When** it runs, **Then** each behaves per its mode.

---

### User Story 4 - Channel-aware input collection (Priority: P2)

Routine input collection — whether from a chat collection step or an untyped fill gap — gathers inputs per a **channel-provided batching policy**. In synchronous chat the agent may ask incrementally; over email it batches every input it can determine it will need into a single message. This is the in-routine step-input collection 085 deferred; 090 owns it on the routine's slot machinery.

**Why this priority**: Without it an email routine becomes an unusable stream of one-question emails. P2 because email is first-class (087/089).

**Independent Test**: Run a routine that collects two inputs over chat and over email; confirm chat may collect incrementally while email collects both in one message; confirm email does not pre-ask for an input gated behind an undecided branch.

**Acceptance Scenarios**:

1. **Given** two pending inputs on a chat channel, **When** collection runs, **Then** the agent may ask incrementally per the chat policy.
2. **Given** the same on an email channel, **When** collection runs, **Then** the agent batches the collectable inputs into one outbound message.
3. **Given** an input required only behind an undecided branch, **When** email batching plans the ask, **Then** it is not pre-asked (bounded by the guaranteed-reachable prefix).
4. **Given** a routine, **When** authored, **Then** the same routine serves both channels — no per-channel duplicate authoring.

---

### Edge Cases

- Skill schema changes after authoring → bindings to now-missing inputs and output assignments to now-missing fields MUST surface as diagnostics, not silent drops.
- A variable reference to a step that may not run on a path: *required* input → flagged (typed) / collected (untyped); *optional* → unset.
- Variable name collision across sources → flagged.
- Empty untyped candidate set → flagged at author time.
- Literal values for sensitive inputs follow the bound-param posture (author-fixed, not conversation-overridable).
- Skill with no output data schema (typical MCP/external) → no bindable data-output variables; only outcome-based routing is available (see descriptor contract).
- Untyped step outputs: chosen skill is unknown until runtime, so untyped output→variable assignment is not author-bindable; downstream typed references to an untyped step's outputs are out of scope for v1 (Q-A).

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector`.
- LLM integrations MUST use the configured default provider; untyped argument-fill and any collection copy MUST be LLM-generated (no hard-coded conversational strings; multilingual must hold).
- Backend development MUST follow TDD: tests written and failing before implementation.
- Frontend user-visible behavior MUST prefer Playwright; frontend unit tests stay on non-visual logic (variable namespace, binding model, validation, descriptor normalization).
- Secrets in `.env`, never committed; `.env.example` updated if new config is added.
- Customer data least-privilege; the exposed-input allow-list invariant MUST be preserved (the agent may only fill author-eligible inputs).
- Admin pages use the shared dark theme and existing tokens.
- Preserve modular boundaries between transport, orchestration, domain, persistence.
- Identify files/modules that must stay responsibility-limited.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: Transport = routine REST + editor. Orchestration = routine runner + skill dispatcher + input-collection planner. Domain = routine definition/compiler/validator + variable namespace + skill I/O descriptor + argument resolver + population/path analysis. Persistence = routine variable + binding + output-assignment storage; existing skill definitions. The conversation engine consumes resolved inputs (or a resolver port); it never learns about authoring popovers.
- **Encapsulation Rule**: The editor reads skills only through the new **read-only `SkillAuthoringCatalog` port**; no imports of `externalSkills`/`customerEmail` internals. `skillDispatcher` stays dispatch-only. `compiler.ts`/`validator.ts` gain variable/binding/population validation but stay pure. `mergeToolInput`'s allow-list/author-fixed invariant MUST be preserved by the resolver. The **channel batching policy and collection planner are routine/engine-owned** (the deferred 085 step-input detector), NOT the 085 Clarifier; 090 MUST NOT route in-routine collection through the suppressed-during-routine Clarifier.
- **New Seams Required**:
  - `SkillAuthoringCatalog` — skills for an agent with normalized input/output descriptors, across all kinds.
  - **Variable namespace** extension — skill-output→variable assignment persisted on the step; written into runtime `variables`.
  - **Input binding model** — per input: `literal | variableRef`.
  - `SkillArgumentResolver` — produces dispatch input from bindings + `variables`; no LLM pass when all required inputs resolve deterministically.
  - **Population/path analysis** — "is variable V guaranteed-populated at step S?"; shared by validation (R5) and email batching (US4).
  - **Input-collection planner + `ChannelBatchingPolicy`** — chat incremental ↔ email batch-to-prefix; routine-owned.
- **Anti-Goals**: no expression DSL (`literal | variableRef` only); no two-place binding (settings `slotBinding` migrated away); no LLM fill pass when typed resolves; no bypass of capability gates / exposed-input allow-list; no per-channel routine duplication; untyped selection stays per-step (no agent-level tool pool — spec-072 territory); do not reuse the 085 Clarifier for in-routine collection.

## Requirements *(mandatory)*

### Functional Requirements

**Schema visibility & variable namespace (US1)**

- **FR-001**: Expose to the authoring layer each skill available to an agent with normalized input variables (key, type, required, description) and an output descriptor (data fields when present; outcome set always) — see Skill I/O Descriptor Contract.
- **FR-002**: The catalog MUST cover all skill kinds behind the skill port (retrieval, external/MCP, customer-email) via one normalized descriptor shape.
- **FR-003**: A routine has one namespace of uniquely-named typed variables sourced from collection-step slots and skill-output assignments; names unique; collisions flagged.
- **FR-004**: Validation MUST flag an unknown-skill reference and a required input that is neither bound nor eligible for fill, and block publish.

**Typed binding (US2)**

- **FR-005**: A skill input MUST be bindable to exactly one of: a typed literal, or a routine-variable reference. No other value form.
- **FR-006**: A skill step MUST be able to assign output fields to named routine variables; bindings and assignments are authored on the routine and travel with export/import (079/082).
- **FR-007**: At dispatch the resolver MUST produce the input deterministically from bindings + `variables`, preserving the exposed-input allow-list and author-fixed-literal posture.
- **FR-008**: When every required input resolves to a literal or guaranteed-populated variable, the turn MUST NOT invoke an LLM argument-fill pass.
- **FR-009**: Validation MUST ensure required inputs resolve to a literal or guaranteed-populated variable, with types compatible with the declared input type (type vocabulary per the descriptor contract).
- **FR-010**: Typed mode MUST have no runtime input gaps: a publishable routine never reaches a typed skill step with an unresolved required input.

**Untyped fill (US3)**

- **FR-011**: A skill step MAY toggle to untyped, delegating choice to the agent over an author-scoped per-step candidate set.
- **FR-012**: For an untyped step the agent MUST fill the chosen skill's inputs from context against its input schema; a missing required input MUST trigger routine input collection (US4) — NOT the 085 Clarifier, NOT a guessed/failed call.
- **FR-013**: Untyped selection and dispatch MUST honor the same per-skill capability gates as typed dispatch.

**Channel-aware collection (US4)**

- **FR-014**: Routine input collection (collection steps and untyped fill) MUST batch per a channel-provided policy: chat MAY collect incrementally; email MUST batch collectable inputs into one outbound message.
- **FR-015**: Email batching MUST be bounded by the guaranteed-reachable prefix; inputs required only behind an undecided branch MUST NOT be pre-asked.
- **FR-016**: A single authored routine MUST serve all channels; channel differences are policy, not duplicate authoring.

**Cross-cutting**

- **FR-017**: One skill step kind MUST carry the mode (typed default / untyped) as a popover toggle, not two distinct step kinds.
- **FR-018**: Skill output variables MUST be referenceable by downstream steps for input binding and field-guard routing; field guards resolve against the variable namespace (existing `outputs`-first fallback preserved).

**Migration (Medium-5)**

- **FR-019**: Existing routines using skill-side `exposedParams.slotBinding` MUST be migrated to per-step variable bindings with no behavior change, per a deterministic rule:
  - For each routine step referencing a skill, generate a per-step binding for each exposed input: `input ← variableRef(slotBinding ?? paramName)`.
  - The skill definition RETAINS `exposedParams` as the **allow-list** (which inputs are exposable) but `slotBinding` (the routing default) is removed once all referencing steps are migrated.
  - **Compatibility window**: the resolver dual-reads — per-step binding if present, else skill-side `slotBinding`. After backfill verifies all referencing steps carry bindings, the fallback (and `slotBinding` storage) is removed.
  - Assistant/customer-facing behavior MUST NOT change; `exposedParams` remains the security allow-list throughout.

### Skill I/O Descriptor Contract

Normalizes heterogeneous skill kinds into one descriptor for authoring and validation.

**Source of truth (confirmed against code):** built-in, retrieval, and customer-email skills already expose typed `intake.fields` and structured `outcomes` on the existing skills catalog (spec 059, `SkillCatalogEntry`). The descriptor is a projection over that shape — *not* over raw `inputSchema`/`outputSchema`. Only external/MCP skills lack a catalog entry; they are projected from `exposedParams` + `declaredOutcomes`/`outcomeMap` (a later slice).

- **Inputs**: from the catalog entry's `intake.fields` (built-in/retrieval/email) or the external definition's exposed params. The descriptor preserves the richer **display vocabulary** `text | number | boolean | email | date | phone | enum` (with `enumValues` for enums), because that is useful when authoring; the catalog's `string` maps to `text`, and an external param with no declared type defaults to `text`. Collapsing this onto the narrower routine variable vocabulary `text | number | boolean | email | date` happens at **validation time** (type-compatibility), deliberately not in the descriptor. Bound params are author-fixed and never shown as bindable.
- **Outputs** have two parts:
  - **Outcome set** — always present: external `declaredOutcomes`/`outcomeMap`, or the contract `outcomeKinds`, or the skill status. Drives field-guard/branch routing. Available even when no data schema exists.
  - **Data fields** — present only when the skill declares an `outputSchema`. Many MCP/external skills do not; absent schema → **no bindable data-output variables** (FR-006 output assignment is unavailable for that skill), and only outcome-based routing is offered. The descriptor MUST mark whether data fields are available.
- The descriptor is a read-only projection; it never exposes secrets, bound-param values, or provider internals.

### Key Entities

- **Routine variable**: uniquely-named typed value; sourced from a collection-step slot or a skill-output assignment.
- **Skill I/O descriptor**: normalized inputs (key, type, required, description) + output descriptor (outcome set always; data fields when `outputSchema` present).
- **Input binding**: per input, `literal` (author-fixed typed value) or `variableRef`.
- **Skill step mode**: `typed` (bindings + output assignments) or `untyped` (per-step candidate set + agent fill); a popover toggle on one step kind.
- **ChannelBatchingPolicy**: channel-provided collection cadence (incremental ↔ batch-to-prefix).

## Resolved Decisions & Open Questions *(for discussion)*

**Resolved during design discussion + Codex review:**

- **R1 (default mode)**: Typed with empty ports; agentic is opt-in via the popover toggle.
- **R2 (binding form)**: One variable namespace; input binds to `literal | variableRef`; no per-input source policy (collection-from-customer is a collection step, not a flag).
- **R3 (`slotBinding` fate)**: Migrate to per-step bindings with a compatibility window (FR-019); do not dual-track permanently.
- **R4 (untyped scope)**: Per-step candidate set only; no routine/agent pool.
- **R5 (branch-conditional refs)**: Required + not-guaranteed-populated → flagged (typed) / collected (untyped); optional → unset. Same path analysis powers email batching.
- **R6 (in-routine collection ownership)**: 090 owns in-routine input collection on the routine's slot machinery — the step-input collection 085 deferred. 090 does NOT reuse the 085 Clarifier (which is suppressed during routines). Channel batching is a new routine-owned concern, shareable with 085 later but not dependent on it. *(Corrects the earlier draft's "reuse 085.")*
- **R7 (typed runtime gaps)**: Typed mode has none — required typed inputs must resolve at publish to a literal or guaranteed-populated variable (FR-009/FR-010). Runtime collection occurs only via collection steps and untyped fill. *(Resolves the US2/US4 contradiction Codex flagged.)*
- **R8 (descriptor normalization)**: One normalized descriptor projected over the existing 059 catalog (`intake.fields` + `outcomes`) for built-in/retrieval/email skills, and over `exposedParams` + `declaredOutcomes` for external skills. Descriptor keeps a richer display vocabulary; collapse to the routine variable vocabulary is validation-time. Outputs = outcome set (always) + data fields (only with `outputSchema`); absent schema → outcome routing only. *(Codex High-4; refined during implementation — source is the 059 catalog, not raw JSON schema.)*
- **R9 (namespace vs existing slots)**: Slots remain the customer-collected variable source (`routine_slot` unchanged); the runtime `variables` map is the namespace; skill-output assignment is the only additive write into it; `{{n<key>}}` and field guards keep working. *(Codex High-3.)*

**Still open:**

- **Q-A (untyped outputs)**: Allow an untyped step's outputs to bind to named variables despite the runtime-chosen skill? v1: no (stay in the agent's reasoning context). Revisit if deterministic routing off an untyped result is needed.
- **Q-B (force-ask)**: An optional per-input "always collect from the customer even if available" flag, e.g. to confirm a destructive value? Deferred past v1.
- **Q-C (literal editor types)**: Which literal editors beyond text/number/boolean/email/date (e.g. enum from the input schema)? Likely follows the input's declared type.
- **Q-D (collect-binding sugar)**: A third binding option `collect` (just-in-time customer collection without a separate step) would re-introduce a typed runtime gap by design. Deferred; reconsider only if explicit collection steps prove too heavy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An author sees a skill's required inputs and outputs entirely within the routine editor — zero trips to the skills settings screen.
- **SC-002**: A routine referencing an unknown skill or with an unsatisfiable required input is rejected at author/validate time (0 such failures reach dispatch in test).
- **SC-003**: A fully-typed skill step adds 0 LLM calls at dispatch; per-turn latency for a fully-typed routine is unchanged vs today.
- **SC-004**: A skill input bound to a collected variable executes with that variable's value with no settings-screen configuration.
- **SC-005**: For an untyped step, a missing required input yields routine input collection (not a failed/guessed dispatch) in 100% of tested missing-input cases.
- **SC-006**: The exposed-input allow-list holds: the agent cannot fill any skill input the author did not declare eligible.
- **SC-007**: The same routine over chat vs email collects two missing inputs in up to two chat messages vs exactly one email, and email never pre-asks for an input behind an undecided branch.
- **SC-008**: Migration preserves behavior: every pre-migration routine that dispatched a skill with `slotBinding` dispatches with identical inputs post-migration (golden-path parity test).
