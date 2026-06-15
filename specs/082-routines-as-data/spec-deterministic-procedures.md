# Spec — Deterministic Procedures for Routines (v1)

**Status:** draft (2026-06-14)
**Parent:** 082 routines-as-data. Design rationale + competitor/code evidence: `amendment-deterministic-guards.md`.
**Depends on:** shipped routine runtime (slices 1–6 + versioning + doc-model authoring #682).

## Implementation status (2026-06-14, one-shot core)

Built + tested at the **data/runtime/API layer** (not the visual editors):
- **FR-4 deterministic field guard** — new `field` guard (`{ref, op, value/values}`, ops `is_true/is_false/equals/not_equals/in/is_present/is_absent`) in the contract union; evaluated in the engine's `guardMatches` **before** the selector (resolves from skill `outputs` then slots); compiled by `compiler.ts`; validated by `validator.ts`; authorable via REST/SDK/MCP (OpenAPI regenerated + contracts in sync).
- **FR-5 provenance** — pure `routineGuardProvenance(guardKind)` → `exact | judgment` (everything but `llm` is exact).
- Tests: 3 engine (deterministic branch, no selector) + 5 backend (compile/validate/provenance); engine 94, defaults 44, agents-contract 27, routine units 21 all green; backend tsc + dep-cruiser boundaries + check-api-contracts clean.

**Not yet built** (honest gaps, for the "discuss after"): typed tool output *schema* (FR-1/2 — runs on the existing untyped `outputs` bag) + starter library (FR-3) → now its own spec, `spec-typed-tool-io.md`; validation gate (FR-8/9). **Editor work (decided IA above):** retire the outline (which removes the lossy field-guard→default downgrade); teach the **form** the "decide by a rule" branch option + the "decided in code / by AI" labels; build the 3-field **prose editor**. Provenance is a pure helper, surfaced client-side from guard kind for now (backend read-DTO only once the typed-tool "is the backing field real?" check lands). Confirm-by-consequence, inferred-type-for-gates, and the residual comparison are unbuilt.

## Summary

Today a routine's conditions are either model-evaluated prose (`llm` guard) or one of three structured guards (`slot_filled`/`outcome`/`counter`). Conditions that *should* be deterministic — "older than 6 months", "final-sale", "5 most recent completed" — are model-evaluated and unreliable, with no signal to the author that they're a guess. This spec makes the provable subset deterministic by pushing it to **typed tool outputs**, lets routines **branch on typed fields** in prose, and — the load-bearing requirement — makes the **exact-vs-judgment boundary visible** to the author. It also adds a compiler-inferred **validation gate** before irreversible actions.

It deliberately does **not** add an in-routine expression DSL, and does **not** tackle intra-turn suspend/resume or multi-intent (separate efforts).

## Problem & goals

A routine condition welds deterministic data-logic, semantic judgement, and wording into one decision. We separate the deterministic part into code, keep the rest with the model, and show the author the line.

**Goals**
- G1. Provable conditions (gates, comparisons over tool data, filters/limits) evaluate deterministically.
- G2. The author can always tell whether a condition is *exact* or a *model judgment*.
- G3. The author authors in prose-with-chips; never writes an expression/AST; never picks a type from a bare dropdown.
- G4. Irreversible actions are guarded by a re-asserted eligibility check (Double-Check).
- G5. Multilingual-safe: structure is authored/selected, never parsed from English.

**Non-goals**
- N1. An in-routine comparison-expression language (deferred; the residual case uses confirm-by-consequence).
- N2. Intra-turn suspend→handle→resume and multi-intent juggling (separate effort; blocked on the one-reply-per-turn spine + step-re-entry side-effects).
- N3. Making the *conversation* deterministic. Only procedure gates are exact; the shell is model-judged.
- N4. Hard-coding any English vocabulary, keyword list, or policy in code.

## Authoring surfaces (decided 2026-06-14)

Two surfaces, a loose-to-strict spectrum; the awkward middle is retired:
- **Prose editor (new, friendly front door):** three fields — **Name**, **Trigger**, and one **Routine** box written as plain prose. The drafting assist turns it into the structured routine. The author never touches structure here.
- **Form (kept, the strict/precise medium):** the exact, field-by-field view; the only place deterministic "decide by a rule" branches (the field guard) are authored/verified precisely, and where each branch is labelled **"decided in code"** / **"decided by AI"** (FR-5).
- **Outline: retired.** Removing it also removes the lossy field-guard→default downgrade (the serializer that caused it is no longer a user-facing editor).

Both surfaces project the one saved draft (round-trip preserved). Field guards are produced from prose by the assist and edited precisely in the form.

## Users & stories

- **Routine author** (non-engineer, e.g. support lead): "When I write a condition that can be checked exactly, I want to see that it *is* — and when it can't, I want to be told, not silently given a guess."
- **Tool author** (engineer): "I expose typed fields (`is_final_sale`, `is_within_refund_window`) and a starter library, so authors branch on reliable data."
- **Operator**: "Refund/eligibility gates are decided by code and audited, not by model vibes."

## Functional requirements

**Typed tool I/O (foundation)**
- FR-1. Tool/action contracts MAY declare a typed **output schema** (named fields with types from the slot type set + list/record). Built on the existing untyped `outputs` bag; backward compatible (no schema → today's behavior).
- FR-2. The runtime binds the last tool result's typed fields into routine state, addressable as `tool.<step>.<field>` for guard evaluation. (Cross-service contract change → message-queue/worker-payload review.)
- FR-3. Ship a **named starter library** of pre-built typed fields / tool templates (enumerated in amendment §4): temporal eligibility (`is_within_window`/`is_older_than`/`days_since`), policy flags (`is_final_sale`/`is_refundable`/`is_already_refunded`/`is_cancellable`/`is_verified`), typed status enums + membership, collection shaping (`most_recent`/`filter_by_status`/`count`/`is_empty`), and counters. Coverage is **measured, not assumed** (SC-8).

**Deterministic branching + provenance**
- FR-4. A new guard form branches on a typed tool field or slot (boolean/enum equality, membership, and tool-computed booleans). Evaluated in the pre-pass before any model call (extends `guardMatches`/`selectNext`).
- FR-5. **Every condition on an exit shows how it is decided**, in plain words: **"decided in code"** (a calculation — same answer every time; names the backing field on inspect) vs **"decided by AI"** (a model judgment). [Load-bearing — see SC-2.]
- FR-6. When an author states a condition with **no backing field**, the surface MUST offer an explicit choice ("add a check via engineering" / "let the assistant decide") and MUST NOT silently emit a judgment guard styled as exact.
- FR-7. Thresholds (e.g. "6 months") are represented **once** — as a tool parameter — and rendered in the prose as a chip echoing that parameter (no re-typed English number that can drift from the param).

**Validation gate**
- FR-8. The compiler infers a **validation gate** before an irreversible `action`/`tool` step from the deterministic eligibility rule(s) already on the path; on violation it blocks (routes to a recovery/handoff step) or re-prompts. Author does not hand-author it.
- FR-9. A denied/blocked action MUST NOT persist a success message or complete the routine as if it succeeded.

**Authoring surface**
- FR-10. Variable **types are inferred** by default; the author is prompted only contextually (not declaration-before-use). **Exception:** a type that feeds an *exact gate* is confirmed by consequence (FR-11) — a silently mis-inferred type breaks determinism invisibly, the exact failure class this spec removes. Inference is a convenience for non-gate variables, never a silent input to a deterministic decision.
- FR-11. Establishing/confirming an exact condition is done **by consequence example** ("Dec 14 → eligible, Dec 13 → not"), never by showing an operator/AST.
- FR-12. Hidden control-flow state is **surfaced as chips**: the retry/attempts counter (with a defined, displayed reset scope) and the user-selection referent.
- FR-13. Fall-through edges are **drawn**, and the validator's existing explicit-exit requirements (action follow-up, counter fallback, reachability) are preserved; dangling/duplicated step-name jumps warn.
- FR-14. A closing step that asks a question but **ends the routine** (reply → fresh turn) is marked distinctly from a question that waits.
- FR-15. Exit-on-demand: a global "user asks for a human" → handoff option, without authoring it on every step.
- FR-16. Compiler stays pure (no LLM at compile). Authoring assist (LLM) is a separate pre-compile surface; structure it produces is author-confirmed by consequence (FR-11).

**Docs**
- FR-17. Authoring guide updated: provenance, confirm-by-consequence, typed-field branching, the determinism boundary (what's exact vs judged), validation gates. Engineer-facing doc for typed tool output schemas + the starter library.

## Success criteria

- SC-1. A routine branching on "older than 6 months / final-sale / 5 most recent completed" makes the correct branch on adversarial dates/statuses **without a model call** for those branches (golden tests at temperature 0).
- SC-2. In usability testing, authors correctly identify which conditions in a routine are *exact* vs *judgment* with high accuracy — the provenance is legible. (The rev-1 blocker; if this fails, the feature fails.)
- SC-3. No author authors an expression/AST or picks a bare type dropdown to get a deterministic gate (observed in testing).
- SC-4. An irreversible action with a failing eligibility rule is blocked and does **not** report success (test).
- SC-5. A threshold value appears in exactly one place; editing it cannot create prose/param drift (test).
- SC-6. No English keyword list, verb list, or policy literal in code paths (boundary lint + review).
- SC-7. Tool output schema change resyncs SDK + MCP + worker payload contracts; full backend suite green (catches contract drift).
- SC-8. In pilot, the share of authored conditions resolving to an **exact** gate vs falling back to **judgment** is measured and reported per routine; a target floor is set before GA. (Guards R1 "thin library → false rigor": if most real conditions fall back, the determinism bet is failing and we say so rather than ship false rigor.)

## Risks

- **R1 (highest): thin field library → "competitor + extra concepts + false rigor."** If authors routinely lack backing fields, determinism rarely applies and the added concepts aren't worth it. Mitigation: FR-3 starter library; measure exact-gate hit rate.
- **R2: provenance UX reads like a debugger.** Mitigation: consequence-based language (FR-11), restrained visual treatment; validate via SC-2.
- **R3: typed tool I/O can't cover real data** (MCP/third-party tools return untyped JSON). Mitigation: graceful fallback to judgment guard *with visible provenance* (FR-5/6) — honest degradation, not silent.
- **R4: confirm-by-consequence still trains rubber-stamping.** Mitigation: show *boundary* examples (the day on each side), not just a happy example.
- **R5: contract change blast radius** (SDK/MCP/AMQP). Mitigation: additive schema, FR-1 backward compatible, SC-7 gate.

## Dependencies & phasing

Phasing per amendment §14: (1) typed tool I/O + starter library → (2) branch-on-typed-field + provenance → (3) validation gate → (4) authoring fixes → (5) residual comparison → (6) docs. Phase 1 likely **graduates to its own spec** (typed tool I/O is cross-cutting beyond routines).

Out of scope (separate efforts): intra-turn suspend/resume + multi-intent (N2); in-routine expression language (N1).
