# Spec — Typed Tool I/O (foundation)

**Status:** draft (2026-06-14)
**Relationship:** foundation under `spec-deterministic-procedures.md` (the field guard runs on the *untyped* `outputs` bag today; this makes it typed + verified). Graduated to its own spec because it is **cross-cutting beyond routines** — it changes the tool/action contract that retrieval, the agentic capability, the SDK, the MCP server, and worker/AMQP payloads all share.

## Summary

Tools/actions currently return a `status` discriminator plus an **untyped** `outputs?: Record<string, unknown>` bag that nothing can safely reference. This spec lets a tool **declare a typed output schema** (named fields with types), **binds** those fields into routine state so a deterministic branch can reference them by name, and **verifies at publish time** that a branch's referenced field actually exists — so the "decided in code" label can be *honest* rather than a hopeful guess. It also ships a **starter field library** so common gates (date windows, status flags, recency/limit) are typed out of the box.

## Why it matters (the honest dependency)

Two claims in the deterministic-procedures spec are unsupported without this:
1. **"Decided in code" must be honest.** A branch that checks a field **no tool provides** is not reliable — it's a broken reference. Only the backend, knowing the tool's declared outputs, can tell the author "nothing measures this yet" (deterministic-procedures FR-6). That check needs typed outputs.
2. **The bet only pays if exact gates are common.** If authors keep needing fields no tool exposes, determinism rarely applies (deterministic-procedures R1/SC-8). The starter library is the mitigation, and it lives here.

## Goals / non-goals

**Goals**
- G1. A tool/action can declare a **typed output schema**; the runtime exposes the last result's fields as addressable, typed values (`tool.<step>.<field>`).
- G2. Publish-time verification that a field-guard reference resolves to a declared field of a compatible type; otherwise an author-facing diagnostic (not a silent "exact").
- G3. A **starter library** of typed field/template shapes so common gates are exact by default.
- G4. Backward compatible: tools without a declared schema behave exactly as today (untyped bag, `status`-only branching).

**Non-goals**
- N1. Typing arbitrary third-party/MCP tool payloads we don't control (they degrade to *untyped* → branches on them are honestly labelled "decided by AI" or rejected, never falsely "in code").
- N2. The in-routine expression language (still deferred).
- N3. Computing business logic in the routine — the *tool* computes the typed field; the routine only branches on it.

## Functional requirements

**Contract**
- FR-1. The tool/action registration contract gains an optional **output schema**: named fields, each with a type from the slot type set (`text|number|boolean|email|date`) plus `enum`(values) and `list`(of a typed item). Additive; absent schema = today's untyped behavior.
- FR-2. The runtime binds the last skill result's typed fields into routine state, addressable as `tool.<stepId>.<field>`; the field guard's `ref` resolves against these first, then slots (the existing precedence). Untyped `outputs` still flow as today for tools without a schema.
- FR-3. **Thresholds are tool parameters.** A tool may declare typed **inputs** (e.g. a refund-window duration) so "6 months" is a parameter the routine passes, computed inside the tool, surfaced as a typed boolean output — not re-typed in the routine.

**Verification (honest provenance)**
- FR-4. At publish, a `field` guard whose `ref` does not resolve to a declared output field (for a schema-bearing tool on the path) or a declared slot produces a diagnostic; it is **not** published as "decided in code."
- FR-5. Type compatibility is checked: the operator must be valid for the referenced field's type (e.g. `in` needs an enum/list; `is_true` needs a boolean). Mismatch → diagnostic.

**Starter library**
- FR-6. Ship reusable typed templates engineers instantiate per tool: temporal eligibility (`is_within_window`, `is_older_than`, `days_since`), policy flags (`is_final_sale`, `is_refundable`, `is_already_refunded`, `is_cancellable`, `is_verified`), typed status enums + membership, collection shaping (`most_recent`, `filter_by_status`, `count`, `is_empty`).

**Cross-service contract**
- FR-7. The output-schema change is reviewed for SDK, MCP, and **document worker dispatch / AMQP payload / retry semantics** impact (per the repo's contract-change rule); generated artifacts (OpenAPI/SDK/MCP) resynced; queue docs/tests updated if affected.
- FR-8. Observability: a tool result with a declared schema records field *names/types* bound (never the values — no tool output content, PII, or payloads in logs/metrics).

## Success criteria

- SC-1. A tool declaring `{ is_within_refund_window: boolean }` lets a routine branch on it with the branch labelled **"decided in code"**, evaluated without a model call (golden test).
- SC-2. A field guard referencing an undeclared field is **rejected at publish** with a clear diagnostic (test) — never shipped as a silent guess.
- SC-3. A tool with no output schema behaves exactly as before; existing routine/contact tests unchanged (regression gate).
- SC-4. Exact-gate coverage (deterministic-procedures SC-8) measurably rises once the starter library lands; reported per pilot routine.
- SC-5. OpenAPI/SDK/MCP resynced and in sync; worker/AMQP payload review recorded; full backend suite green (catches contract drift).
- SC-6. No tool output values in any log/metric/trace (observability lint + review).

## Risks

- **R1. Untyped reality.** The tools authors most reach for (third-party/MCP) can't be typed. Mitigation: honest degradation — such branches are labelled "decided by AI" or rejected, never falsely "in code" (N1, FR-4).
- **R2. Contract blast radius** (SDK/MCP/AMQP/connector-api). Mitigation: additive schema, FR-1 backward compatible, staged resync, FR-7 review.
- **R3. Scope creep into the expression language.** Mitigation: tools compute fields; the routine only branches (N2/N3).

## Phasing

1. Output schema on the contract + runtime binding (`tool.<step>.<field>`), backward compatible.
2. Publish-time backing-field + type verification (FR-4/5) → flips the field-guard provenance from "structurally exact" to "honestly exact."
3. Typed inputs / threshold-as-parameter (FR-3).
4. Starter library (FR-6).
5. SDK/MCP/AMQP resync + queue review + docs (FR-7).

Once phase 2 lands, provenance moves from a client-side guess to a backend read-DTO fact (deterministic-procedures FR-5 / question #3).
