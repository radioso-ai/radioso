# 082 Amendment — Deterministic Procedures (honest shape)

**Status:** design / pre-plan (rev 2, 2026-06-14, after adversarial pressure-test)
**Thread:** routines-as-data (082). Builds on the shipped runtime (slices 1–6 + versioning) and the authoring-surface amendment.
**One-line:** A routine is a **deterministic procedure inside a model-driven conversation**. Evaluate the *provable* parts (gates, comparisons, filters) in code; leave the *semantic* parts to the model; and — the part rev-1 missed — **make the boundary between the two visible to the author.**

> Naming rule: describe mechanisms, do not name competing products in repo artifacts.

---

## 0. What changed in rev 2 (the pressure-test corrected rev 1)

Two independent agents stress-tested rev 1. Both changed the design:

- **The "routine tunnels the turn" claim was REFUTED against live code.** When a routine is active and the user goes off-topic, the next-step selector returns `yieldTurn` (`packages/conversation-defaults/src/routineNextStepSelector.ts:192`, off-topic classified by `backend/prompts/chat/routine-next-step.md`); `attemptRoutine` returns `null` (`conversation-engine/src/index.ts:606`) and the turn **falls through to retrieval in the same turn**. So "what's your return policy?" mid-refund **is** answered. What's missing is narrower (see §9): *intra-turn* suspend→handle→resume and multi-intent. The blocker for those is the **one-reply-per-turn composition spine + step-re-entry re-firing side effects**, NOT streaming (live) or persistence (RoutineState already suspends intact).
- **The determinism boundary was invisible — the central flaw.** Rev 1 sold "determinism inferred under the hood; the author writes the same sentence either way." The red-team's verdict: that is exactly the problem. A provable gate ("more than six months old", backed by a typed field) and an LLM guess ("from a banned SKU", no backing field) render as **identical prose on identical edges**. The author cannot tell reliable from coin-flip. **Fix = make exact-vs-judgment visible (§5). This is both the fix and the differentiator.**

Other verified facts (live tree): compiler is pure, no NL inference (`compiler.ts:19,43`); validator enforces reachability + explicit exits for action/counter steps (`validator.ts:158,204,237`); tool results carry only a `status` discriminator a guard can branch on, plus an **untyped** `outputs?: Record<string,unknown>` bag that is *not* bound to state and *not* guard-addressable (`conversation-contract/index.d.ts:179,602`); slots are typed `text|number|boolean|email|date` (`domain.ts:18`).

## 1. Problem

A condition like *"if the order is older than 6 months → handoff"* welds three different decisions together:

1. **Deterministic data logic** — a comparison/filter/count/gate. One correct answer given the data.
2. **Semantic judgement** — *"if the customer seems upset"*. Irreducibly a language call.
3. **Wording.**

Runtime-reasoning competitors collapse all three into one LLM call (`condition: str` → `generate()` → `applies: bool`), so the model does date math and filtering — unreliably, exactly where it matters (refunds, eligibility, money). We separate (1) into code, keep (2)+(3) with the model, **and show the author which is which.**

## 2. The honest shape (what rev 1 over-claimed)

Strip the marketing rev 1 drifted into and the true design is:

- **Not "deterministic agent." A deterministic *procedure* inside a *model-driven conversation*.** The conversation (entry, digression, suspend/resume, exit) is model-judged — it always had to be; "did the user change the subject" is as semantic as "did they approve." Only the *procedure's gates* are exact.
- **Not "no-code." "No-syntax" trending toward no-code.** The author writes prose; we remove punctuation/operators. But control flow, types, and the determinism boundary are real concepts we must *surface honestly*, not hide.
- **Determinism is not free or invisible.** It costs (a) typed tools beneath the prose and (b) a visible signal of where it applies. The product's value is **honesty about what's deterministic**, which neither competitor offers.

## 3. Evidence base

- Competitor runtime is LLM-all-the-way (verified in open source): `condition: str` → `generate()` → `applies: bool`; no operand/operator type exists.
- The leading commercial runtime markets *against* determinism ("without rigid scripted framework"); low voice latency is perceived-performance masking, not compilation (determinism wouldn't help voice latency — the cost is generating words).
- "Blueprint First, Model Second" (τ-bench retail/airline): **+10.1pp Pass^1, −81.8% tool calls.** Ablation: structure alone +1.1pp; **codified validation gate +11.7pp (dominant)**; tool consolidation +5pp. Their authoring is *developer-written code* ("manual blueprint creation"; semi-automation is their future work) — the gap our compiler fills.

## 4. Where determinism actually lives (revised: at the tool boundary)

Rev 1 reached for an in-routine comparison-expression language. The pressure-test showed most determinism should **not** be an expression in the routine — it should be a **typed field the tool returns**, branched on in prose:

- `Check Order` returns typed fields: `is_final_sale: bool`, `is_within_refund_window: bool` (computed from a window passed as a tool **parameter**), `recent_completed: Order[]` (already filtered/sorted/capped). The author writes *"if the order is final-sale, explain the policy"* — deterministic because the field is typed; **no expression authored.** This reads like prose referencing `@email`.
- This relocates the structuring burden from the **non-engineer author** to the **engineer who defines the tool** — the right place: it can be truly deterministic, verified, and written once.
- **Consequence (strategic linchpin):** the no-code surface is only as deterministic as the tools beneath it. If authors routinely need fields tools don't expose, we degrade to "competitor + extra concepts + false rigor." This is the design's biggest risk and **must not stay a hand-wave** (the 2nd pressure-test's top finding). v1 ships a **named starter typed-field/template library**, instantiated per tool by the engineer:
  - *Temporal eligibility:* `is_within_window(date, duration)`, `is_older_than(date, duration)`, `days_since(date)` — the window is the duration **parameter**.
  - *Policy flags (bool):* `is_final_sale`, `is_refundable`, `is_already_refunded`, `is_cancellable`, `is_verified`.
  - *Status (typed enum + membership):* `status in {…}`.
  - *Collection shaping:* `most_recent(list, field, n)`, `filter_by_status(list, set)`, `count(list)`, `is_empty(list)`.
  - *Counters:* attempts/retry (already exists).
  These cover the refund/return/eligibility class end-to-end. **Coverage is a measured gate, not an assumption** (spec SC-8: the share of pilot-routine conditions that resolve to an *exact* gate vs fall back to *judgment* is reported; a low number means the bet is failing and we say so). Untyped third-party/MCP tools that can't be typed degrade to a `judgment` guard **with visible provenance** (§5) — honest degradation, never silent false rigor.
- **Residual (rare):** comparing two pieces of *conversational* state no tool computes (e.g. "stated budget < quoted price"). Only here does the author touch structure — via §6 (confirm-by-consequence), not an expression.

So v1 **excludes** a full in-routine expression sublanguage (matches spec N1). It needs: typed tool fields + branch-on-typed-field (a modest generalization of the `outcome` guard, which today only sees `status`) + threshold-as-tool-param. The expression language is a later, smaller feature for the residual only.

## 5. Core principle (NEW, the rev-1 blocker): the determinism boundary is visible

Every condition on an exit renders its **provenance**, differently and unmistakably:

- **Exact** — backed by a typed field/param. Solid treatment; on inspect, names the field (`is_within_refund_window`). "Checked the same way every time."
- **Judgment** — semantic, model-evaluated. Distinct treatment (e.g. dashed, "the assistant decides").

And: when an author writes a condition with **no backing field**, the surface does not silently make it a judgment guess — it offers the choice: *"Nothing measures this yet. Ask engineering to add a 'banned SKU' check, or let the assistant decide?"* This is what makes the determinism bet **falsifiable to the author**, kills the "identical prose, different reliability" trap, and is the single most important thing to build.

## 6. The structuring moment: confirm by consequence, never by expression

For the residual (§4) and for any exact gate the author is establishing, the author is **never** shown an AST (`order_date · older_than · 6mo`). They are shown **consequences they can judge**:

> *"An order placed Dec 14 would be eligible; Dec 13 would not. Is that right?"*

A support lead can ratify dates; they cannot ratify `>=` vs `>`. This removes DSL-feel *and* defeats rubber-stamping (the failure mode where "confirm" manufactures false confidence). Boundary semantics (inclusive/exclusive, "6 months exactly") surface as concrete examples, not operators. **Limit (honest):** this covers *single-threshold* gates. A *compound* gate (final-sale OR outside-window OR no-results) is **decomposed into one exact gate per edge** (each consequence-confirmed on its own), or — if genuinely entangled — falls to a single `judgment` guard. We never fabricate determinism for a compound the author can't ratify by example.

## 7. The deterministic pre-pass + validation gate

- **Pre-pass:** before step/branch selection, resolve typed state (slots + the tool's typed fields + env) and evaluate structured guards in code — extends the existing pre-selector path (`routineRunner.ts` `guardMatches`/`selectNext`, today: `slot_filled`/`outcome`/`counter`). Branch resolves without the model when it can; the model runs only for `judgment` guards and wording, receiving the resolved facts.
- **Validation gate (Double-Check, the +11.7pp lever):** before an irreversible `action`/`tool` step, re-assert the deterministic eligibility rule established earlier; on violation, block (route to recovery) or re-prompt. **The author does not author this** — because the eligibility rule already exists as an exit, the compiler re-asserts it at the action (catches "lost-in-the-middle"). The gate also doubles as the **resume-safety** check after a digression (§9): state may have changed while away.

## 8. Authoring model (prose-with-chips, with the red-team fixes)

Default surface = prose SOP with typed inline chips. Two principles: **prose not syntax**; **steps are activities, conditions are exits** (every step opens with a verb; conditions live on transitions).

**Honesty note (2nd pressure-test):** most items below were **already committed** in `amendment-authoring-surface.md` (inferred types; conditions-as-exits / branch-vs-nuance; LLM-assist-with-pure-compile; surfaced state; drawn flow). They are *reaffirmed*, not invented here. The **genuinely new** content of this amendment is narrow and lives in §4–§7: provenance-as-computed-property (§5), typed-field branching (§4), the validation gate (§7), confirm-by-consequence (§6). The authoring items, restated:

- **Infer variable types; don't make authors pick a dropdown.** Type comes from the question/field/tool return; prompt only when a comparison needs a type we can't infer, and prompt in context ("Is this a date?"), never as declaration-before-use.
- **Provenance on every condition** (§5) — exact vs judgment, visibly.
- **Confirm by consequence** (§6) — never show an expression.
- **Surface hidden control-flow state as chips.** "After two tries" → a visible attempts chip with a defined reset scope; "the order they pick" → a visible selection chip. No invisible counters or pronouns-over-arrays.
- **Render fall-through edges visibly** and warn on dangling/duplicated step-name jumps. Fall-through makes step *order* load-bearing; an author reordering a "just a list" must see the edges. (Note: the validator already *requires* explicit exits for action/counter steps — `validator.ts:158,237` — so fall-through is allowed only where the validator permits, and is always drawn.)
- **Editor auto-hoists condition-first steps.** Natural SOP prose ("If Gold member, waive the fee") violates "conditions are exits" constantly; the authoring assist offers to split body→activity + condition→edge. (Authoring-time LLM assist is allowed; *compile* stays pure — §3.)
- **Closing semantics made explicit.** A step whose last sentence is a question but which *ends the routine* (reply starts a fresh turn) is marked distinctly from a question that *waits* — otherwise they look identical and surprise the author.
- **Chips:** typed **variables** (inferred type + icon); **tools** (`🔧 Check Order`); **named handoffs** (`@handoff`, `@handoff_to_sales`, each a separately-defined destination — reuse existing handoff/contact-delivery infra, do not fork); **step-reference** jumps.

The DSL-looking markup remains the **expert/validation lens only**, never the authoring surface.

## 9. Digressions (corrected)

The off-topic→yield→retrieval path already exists (§0), so the highest-frequency, most-embarrassing case (knowledge question mid-flow) is handled — answered next turn, routine resumes with state intact (no new persistence). v1 **leans on this** and adds only **exit-on-demand** ("give me a human" → handoff) as a global option.

Deferred (honestly out of v1): **intra-turn** suspend→answer→resume (today costs a turn) and **multi-intent** juggling. Their blocker is not streaming/persistence but the **one-reply-per-turn composition spine** and **step-re-entry re-firing side effects** (the bounded-walk guard exists because re-entry re-dispatches skills/actions — `routineRunner.ts:308`). This is core-loop/composition work and should be sequenced as its own effort, not smuggled into v1.

**State the trade baldly (positioning):** on the axis the competitor wins — fluid inline digression — v1 demos *worse* (the mid-flow knowledge answer costs a turn). We accept that to win the trust/audit axis. Marketing must say so, not imply parity.

## 10. Multilingual safety

Every structured construct (typed field reference, threshold param, counter, the residual comparison) is **authored as structure or selected from typed config**, and **rendered** as localized prose. We never regex English. Author-provided example phrases (escalation triggers) are allowed as few-shot data on a semantic condition (operator data, not code-level matching). Consistent with the no-keyword-lists rule.

## 11. Boundaries — what stays the model's job

`if the customer approves`, `seems upset`, `implies they don't have another email`: semantic, stay `judgment` guards. Plus all wording, intent, extraction, summarization. The conversation shell (digression classification, suspend/resume/exit) is model-judged by necessity. We carve out the deterministic *gates*; we do not pretend the conversation is deterministic.

## 12. Positioning

|  | No-code authoring | Deterministic gates | Honest about which is which |
|---|---|---|---|
| Runtime-reasoning competitors | ✅ | ❌ | ❌ |
| Blueprint-first research | ❌ (devs write code) | ✅ | ✅ (it's code) |
| **Radioso (target)** | ✅ | ✅ (where tools back it) | ✅ (visible provenance) |

Our compiler is the "semi-automation of blueprint authoring" the research names as future work. Our differentiator over the runtime-reasoning camp is not just *having* deterministic gates — it's **showing the author the line between proven and guessed**, which their `condition: str` model cannot represent.

## 13. Design discipline (what knows what)

- **Provenance/visibility** is a property of a condition derived from whether a typed field backs it — computed, not authored. The editor renders it; it does not own policy.
- **Typed-field resolution** knows typed state + a fixed comparison set; it must not know specific tools or product vocabulary.
- **Tool contract** knows its own typed I/O; concrete tools are adapters behind it.
- **Compiler** stays pure (no LLM). Authoring assist (LLM) is a separate, pre-compile surface.
- Dependency direction: routine (broad product knowledge) → typed-field/guard layer (narrow) → typed state. Composition assembles; domains never reach into it.

## 14. Delivery phasing (sequenced by risk)

1. **Typed tool I/O + a starter field library** *(foundation; the strategic linchpin)* — output schemas on the tool/action contract (build on the existing untyped `outputs` bag), bind typed fields into routine state, pre-built field templates. Cross-service contract change → message-queue/worker-payload review.
2. **Branch-on-typed-field + visible provenance** — generalize the `outcome` guard to typed fields; render exact/judgment on every condition; the "no backing field — add a check or let the assistant decide?" flow.
3. **Validation gate (Double-Check)** — compiler-inferred re-assertion before irreversible actions; observability for fires/blocks/re-prompts. (Highest accuracy lever; pull forward once typed I/O lands.)
4. **Authoring fixes** — inferred types, confirm-by-consequence, surfaced state chips, visible fall-through, auto-hoist, closing marker.
5. **Residual comparison** — the small typed-comparison-for-conversational-state case, authored via confirm-by-consequence.
6. **Docs.**

Out of v1 (separate efforts): intra-turn suspend/resume + multi-intent (§9); full in-routine expression language (§4).

## 15. Open questions

- Threshold ownership: tool-fixed vs tool-param vs residual-comparison — when is each right, and how is "6 months" shown so it lives in exactly one place (no prose/param drift)?
- Field-library coverage: what starter typed fields make authors land on exact gates by default? (If this set is thin, the whole bet weakens.)
- Provenance UX: how to show "exact vs judgment" without making the surface feel like a debugger.
- Does typed tool I/O graduate to its own spec? (Cross-cutting beyond routines — likely yes.)
- Reset scope of the visible attempts counter (per routine / per step / per session).
