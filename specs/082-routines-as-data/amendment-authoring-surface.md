# Amendment: Document-Model Authoring Surface (outline editor + drafting assist)

**Parent**: `specs/082-routines-as-data/spec.md`
**Created**: 2026-06-11 (consolidates and supersedes the earlier `amendment-authoring-document.md` draft and its rev-2)
**Status**: Design (pre-plan)
**Realizes**: the spec's **Graph-Is-Internal Rule** — "the authoring surface is a token-aware structured document." Slice 5 shipped a **form** (one sub-form per step / slot / transition / terminal) as a functional interim. This amendment replaces that form with a document-model surface, and is gated only on its own work — not on #664 (see Scope).

---

## 1. Motivation

The slice-5 composer is form-heavy: the author fills a sub-form per slot, per step, per transition, and per terminal, and explicitly picks enumerated values (step `kind`, guard `kind`, terminal `kind`, slot `type`). It makes a non-engineer think in **nodes, edges, and a guard taxonomy** — i.e. it authors the graph, which the `Graph-Is-Internal` and "no graph canvas" anti-goals exist to prevent. The graph leaked into the authoring surface through the form's shape.

The replacement is the surface the spec describes: **write the routine as an operating procedure for a human agent, in a structured document, and let structure + typed tokens compile to the graph.** The author writes instructions; they never hand-author transitions or guard kinds.

Two surface candidates were considered and rejected for v1:

- **A rich-text editor with inline chips** — the right end state, but an editor-build risk on the critical path. It remains the post-v1 upgrade over the same model.
- **A plain-text sigil format edited in a textarea** (`→ #id [failure]`, `↺2`, `{#anchor}`) — rejected as an author-facing surface: it is the previously rejected guard-syntax DSL re-entering through serialization. Its grammar could not express the flagship worked example (§8.4 relies on nested bullets becoming nodes; the flat line grammar cannot carry it), canonical reflow-on-reload destroys author trust in hand-formatted text, and shipping it would test sigil tolerance rather than the document model. The notation survives **only** as engineer-facing fixture/debug serialization (§14).

The v1 surface is therefore a **structured outline editor** (§4), fronted by an **LLM drafting assist** (§5) — both operating on the same document model the rich editor will later render.

---

## 2. Authoring model

- **A structured document**, edited like an SOP you'd hand a new support rep. An ordered outline of steps gives the flow structure for free. Guidance to the author (verbatim intent): *"Write as if you're instructing a human agent. Type `@` to reference Actions or Variables."*
- **Reference tokens** carry everything typed:
  - **Action** — a reference to a deterministic integration action (compiles to a `tool`/`action` step; FR-008). The action catalog entry declares whether it yields an outcome (→ `tool`, engine waits and branches) or is fire-and-forget (→ `action`).
  - **Variable** — a declared typed slot (compiles to a slot reference / capture point).
  - **Flow targets** — **step references**, **ends** (complete), and **handoff** (escalate-to-human terminal, FR-010) form a single target family, distinct from `@` value/capability mentions. A jump ("return to this step") is a **step-reference token**, never parsed prose like "go to step 5".
  - **Step** — a step is a **declared anchor** carrying a hidden **stable id**. The author sees and edits a free-text label *in any language*; the parser keys on the structural anchor and the stable id, **not** the literal word "Step" (which would break the multilingual rule). This declared identity is what makes node boundaries explicit and what satisfies the Stable-Identity Rule / FR-011 (the id survives recompiles so scoped directives don't orphan).
- **One structured marker** beyond reference tokens: a **counter** (`max N`) on a loop or retry edge — a token/chip, never prose detection of "times"/"attempts" (SC-008).
- **Prose** carries human-facing intent only, and always lands inside a **typed leaf**: a step's instruction, a transition's condition, or a terminal's message. This is consistent with the constitution constraint that an authored instruction is *data that steers generation*, not application copy.

### Anti-goal reconciliation (explicit reading)

The spec lists **"no free-form prose authoring"** as an anti-goal. This surface is **structured** prose — an ordered outline + typed tokens — not free prose: structure and references are machine-parseable, and prose only ever occupies typed leaves. We read this as satisfying the `Graph-Is-Internal` "token-aware structured document," and record it here so the reading is explicit rather than a silent reinterpretation. The anti-goal continues to forbid an *unstructured blob the engine interprets at runtime*; nothing here introduces that.

---

## 3. Scope: routine-first, shaped as slice 1 of a unified document

The same document model naturally compiles to **two** artifacts:

| Section in the document | Compiles to |
|---|---|
| The ordered step flow (numbered stages) | a **Routine** (082) |
| Always-on rules ("General Guidelines", "Edge Cases & Error Handling") | **Directives** (co-apply mid-routine via #664) |

**This amendment scopes the Routine half only (Scope A).** The directive half (Scope B) is the eventual unified "agent instructions" surface; it depends on #664's routine × directive co-composition and is **out of scope here**. But the token taxonomy and the "section → artifact" compile boundary are designed once, so the routine surface is explicitly the first slice of the unified document, not a dead end.

**Confirmed direction (2026-06-11): the editor will eventually hold directives, a glossary, and more.** So the document model is, from day one, a set of **typed sections** — each section declares what artifact it compiles to. v1 implements **only** the routine/step section; "guidelines → directives" and "glossary" sections are recognized placeholders that compile to nothing yet. This is the shim that keeps Scope B (and the deferred glossary, §9) an *addition* of section handlers rather than a rewrite of the parser.

---

## 4. v1 surface: a structured outline editor

**The v1 authoring surface is a structured outline editor**: an ordered list of step cards, each holding

- a free-text **label** (any language; the anchor's display name — the stable id stays hidden and frozen, per FR-015a),
- a free-text **instruction** with inline `@`-mention insertion for **Variables** and **Actions** (stored as the existing `{{slot.key}}` / action-ref encoding),
- zero or more **branch rows**: *condition (free prose, optional)* → *target picker (step / end / handoff)*, plus an optional counter chip (`max N`) — order of rows = precedence (§8.3),
- plus a one-time **Variables** declaration block and an **Ends** block (label + handoff/complete inferred from a Handoff chip, per §7).

All of the §7 inference applies in full: **no kind picker, no guard-kind picker, no terminal-kind picker, no slot-type-on-the-flow**. Guard kind is inferred from what the author attaches to a branch row — prose condition → `llm`; outcome status chosen off an action's declared enum → `outcome`; counter chip → `counter`; nothing → the merged default edge. Step kind is inferred from `@action` mentions. The outline editor is *the form minus every enumerated choice, restructured as an outline* — the inference thesis shipped without betting on either a rich-text editor or a sigil grammar.

**Branch-vs-nuance under this surface.** The §8.1 rule's *model* is unchanged: a branch is explicit structure; an "if" that lives in instruction prose is in-step nuance. What changes is the *input affordance*: in the outline editor the author creates a branch by adding a branch row (explicit), rather than by typing a target token into flowing prose (inferred). The rich editor later restores the inferred affordance ("this `if` branches / this stays guidance" live feedback) over the same model — a pure front-end upgrade.

**The plain-text grammar is demoted, not deleted.** A canonical text serialization is still valuable — golden-test fixtures, debugging, diff review, documentation examples — so the serializer ships, but the format is **engineer-facing fixture notation, never an author-facing product surface** (§14). This dissolves two earlier open decisions: localized section-keyword aliases are moot (authors never see section keywords), and anchor-id surfacing is moot (ids appear only in fixtures and traces).

### Post-v1: the rich editor

The rich-text editor with visual chips and the live branch-vs-nuance affordance is a **later, purely front-end** upgrade over the **same parser and the same model** — no model change when it arrives. The parser/serializer (slice 1) is the durable core regardless of editor, and the **draft, not any text, is the stored record** (§6).

---

## 5. Drafting assist: LLM at the authoring layer, never at compile

The hardest part of authoring is not editing a structured draft — it is composing one from a blank page. Operators already *have* their routines, as SOPs, help-center macros, or tribal knowledge. So:

- **Drafting assist**: the author pastes (or dictates) a free-prose operating procedure; an LLM pass proposes a **structured document draft** — declared steps with labels, candidate variables with types, recognized action references (resolved against the agent's permitted action catalog), branch rows with prose conditions, handoff points. The proposal is emitted as **structured output validated against the document model** (Zod), surfaced in the outline editor as a *reviewable draft*, and passes through the **existing validator** like any hand-authored draft. It is never auto-published.
- **Layering rule (resolves a latent parent-spec contradiction)**: the parent constitution names "the compiler's parse pass" as an LLM integration, while compile-time inference must be purely structural (SC-007). Both are right about different layers: *LLM at the authoring-assist layer, never at the compile layer.* The document→draft projection and the draft→graph compiler remain **purely structural and deterministic** (SC-007, SC-014). The same document always compiles to the same graph; the LLM only ever produces *proposed authoring edits*.
- **Precedent**: this is the established Coach pattern (`backend/prompts/coach/draft-directive.md` — NL → proposed scoped directive, previewed before apply). The assist prompt lives under `backend/prompts/` per constitution; suggested home `backend/prompts/routines/draft-document.md`.
- **Multilingual**: the assist inherits the platform posture for free — the author writes their SOP in their language; structure is extracted by the model, not by English keyword matching. No new keyword/regex path (SC-008/SC-014 re-verified for this surface).
- **Stable ids**: the assist proposes labels; **ids are frozen only when the author saves** (slug-of-initial-label, §14.3) — regenerating a proposal before first save may re-derive ids; after first save, assist-proposed *edits* to an existing draft MUST preserve existing anchors' ids.

Observability: the assist is a new provider-call runtime path — add the standard LLM call span/trace + failure-mode logging (no raw SOP content in logs, per observability rules).

---

## 6. Toggle: document ↔ existing form, both projections of one record

Ship the outline editor **alongside** the slice-5 form with a per-routine view toggle.

- **Single record of truth = `RoutineDefinitionDraft`** (the existing relational definition; Definition-As-Data Rule). Both the form and the document are **total projections** of that draft, exactly as `routineToForm` / `formToRoutineDraft` are today.
- **No document text or AST is persisted as a parallel record.** Toggling re-projects from the draft. (Per the 079 relational-of-record pattern; avoids a document-of-record fork.)
- **Round-trip identity is the contract**, enforced by golden tests:
  - `draft → form → draft` (already true)
  - `draft → document AST → draft`
  - fixture notation: `draft → text → parse → draft`
  all identity. Any construct that cannot round-trip through **both** views is a design bug fixed before ship, not a documented limitation.
- **Serializer consequence**: a structured guard authored in the form (`slot_filled` / `outcome` / `counter`) must project into the document as a **structured branch row / marker**, never as pretty prose — otherwise re-parsing would silently downgrade it to a prose (`llm`) guard and lose determinism. The document representation stays **total** (it can always *display* any guard the draft holds).

### Form retirement: a mechanical trigger, set now

Indefinite dual-maintenance is how transitional surfaces become permanent: every future construct (Scope B sections, glossary) would need projecting into the form too, or the "total projection" contract forks.

**Trigger:** once **10 organically authored or edited routines** have gone through the outline editor across **2 or more workspaces** with **zero round-trip or compile-parity defects** attributable to the document path, the form becomes **read-only** in the next release (existing routines still render; edits route to the outline editor), and is removed one release later absent a documented power-user-edit class the outline editor cannot express. The numbers are deliberately small — the point is that the trigger is *mechanical*, not that it is strict.

---

## 7. The toggles collapse into inference

Today's authoring forces five enumerated choices. The document model removes them as *authoring choices* by **inferring** them from tokens and structure in the document→draft projection. Most need **no runtime/model change** — the compiler still receives the existing draft with explicit kinds; the projection infers them.

| Existing toggle (`domain.ts:16-20`) | Disposition |
|---|---|
| **Step `kind`** `chat\|tool\|fork\|action` | **Inferred from the token**: no action mention → `chat`; Action mention → `tool`/`action` (tool-vs-action from the action catalog entry, not a per-step choice). **`fork` deleted** — it is a phantom (UI never exposes it; `compiler.ts:100` treats it as `chat`). |
| **Slot `type`** `text\|number\|boolean\|email\|date` | **Kept, moved off the flow** onto a one-time Variable declaration (defaults to `text`). Adds zero weight to the step prose. |
| **Slot `required`** | **Kept on the declaration**, not the flow. |
| **Transition `guardKind`** `llm\|always\|fallback\|slot_filled\|outcome\|counter` | **Collapses to ~0 authoring choices** — see §8. The author writes a prose condition, leaves it absent (default edge), or attaches a counter chip; the projection assigns the kind from structural context. |
| **Terminal `kind`** `complete\|handoff` | **Inferred**: `handoff` = the Handoff chip on an end; `complete` = the natural flow end. |

Two are true (small, separate) **schema cuts**, done as their own refactors with runtime/migration impact, not folded into the projection:

- **Delete `fork`** from `routineStepKinds` (dead value).
- **Merge `always` + `fallback`** into a single "default/unconditioned edge" concept; the runtime distinguishes by whether the edge has conditioned siblings.

**Bonus:** the token reframing dissolves the long-standing **action-as-terminal wart** (slice-6 note + review bug P1-2): actions become tokens *inside* steps (fire-and-forget); terminals are only `complete` (flow end) or `handoff` (chip).

---

## 8. Conditionals

A conditional is a step with more than one outgoing edge; the runtime selector picks one (structured guards decided deterministically and short-circuiting, prose conditions evaluated by the next-step selector; `compiler.ts:9-10,33-54`). "Handling conditionals" = deciding, **from structure alone**, where edges come from and what each carries.

### 8.1 The one rule that matters: branch vs. in-step nuance

Not every "if" is a transition:

- *"If it's about an order, also ask for the order ID."* → stays **inside the step's instruction** (one node; the agent decides in-turn).
- *"If the order is older than 6 months → … ; otherwise → continue to Step 5."* → a **flow branch** (the step gets extra outgoing edges).

The rule is **structural, never semantic** (so it is deterministic and multilingual-safe):

> An "if" becomes an **edge iff it resolves to a flow target** — a **step reference** (jump), an **end**, or a **handoff** — or a nested declared sub-step. An "if" that is only a sentence stays as instruction nuance in the current step.

Because steps are **declared anchors** (§2) rather than positions inferred from the outline, "does this branch?" reduces to "does it have a target?" — a crisp, deterministic check, not an outline heuristic. This gives the author a precise, non-magical lever (**want a branch → point it at a step / end / handoff; want in-turn nuance → keep it a sentence**). In the outline editor, the lever is structural by construction: a branch is a branch row with a target picker; nuance is prose in the instruction. The prose's *meaning* is evaluated only at **runtime**, never at compile time.

**Token-less new beat (pinned):** a conditional whose body is a genuinely new conversational beat with no target cannot be expressed as a branch row (every row has a target). For the fixture-notation parser and assist output, an `if`-body that is neither nuance nor targeted is a **validation error in author terms** ("this branch needs a destination — make it a step, an end, or fold it into the instruction"), never silent promotion.

### 8.2 Edge sources and inferred guards

| Document construct | Edge | Inferred guard |
|---|---|---|
| branch row: `if <prose>` → target | conditioned edge to target | `llm`, `condition` = the prose, **verbatim** |
| branch leaving an `@Action` (tool) step with a status chosen from the action's declared enum | success / failure / status branches | `outcome` |
| a target with no condition ("otherwise…") | the default edge | the merged default edge of §7 (`always` if sole exit, else `fallback`) |
| next step in the outline, no explicit branch | implicit fall-through | default edge to next node |
| branch row targeting an earlier step | back-edge (graph is cyclic by design) | per the rules above |
| counter chip (`max N`) on a loop/retry row | bound; exits to the fallback | `counter` |

The author selects **no** guard kind. A compound `A OR B OR C` is a single prose condition on one `llm` edge — mixed conditions cannot be one structured guard, so they compile to `llm` (consistent with "one edge = one guard kind").

### 8.3 Precedence

Sibling branches evaluate in **row/document order** = `ordinal` = first match wins. Structured guards short-circuit first; `llm` edges are weighed by the selector after; the condition-less default ("otherwise") is the last resort. The author controls precedence purely by ordering branch rows, default last.

**Counter-exhausted fallback is the first runtime golden test.** The worked example below asserts, in passing, that the counter-exhausted path lands on the default/fallback edge. That claim becomes the first golden runtime test of the slice-3a guard semantics (`counter` exhausts → forced default edge), pinned with runtime + round-trip tests rather than asserted here.

### 8.4 Worked example

Authored (shown in fixture notation for compactness; in the editor these are step cards with branch rows):

```
Step 4 — Retrieve order details
  1. Thank them for authenticating; let them know you're pulling up their account.
  2. Run @OrderDetails.
     • If @order_date is older than 6 months, OR the API 404s, OR there are no results:
       Tell them you couldn't find recent orders for that email and ask if there's another to check.
         • If they give another email, save it as @email and return to step 1.   (max 2)
         • If they have no other email:   → Handoff  ("no account found")
     • If recent orders are found, continue to Step 5.
  (If it's about an order, also confirm @order_id.)        ← stays inside the step
```

Compiles to:

- **`s4`** — tool step (`@OrderDetails` token; instruction = items 1–2 + the parenthetical nuance). Edges:
  - → **`s4_no_match`**, `llm` condition = *"order_date older than 6 months, OR 404, OR no results"* (body has sub-structure ⇒ a declared sub-step ⇒ a node).
  - → **`s5`**, default edge (the complementary "found" path).
- **`s4_no_match`** — chat step, collects `@email`. Edges:
  - → **`s4`** (loop, "return to step 1"), `llm` condition = *"they provide another email"*, bounded by `counter` (max 2).
  - → **Handoff** terminal, condition = *"no other email"*; the counter-exhausted path also lands here as the fallback.

The parenthetical "confirm order_id" never became an edge (no destination) — it rode into `s4`'s instruction.

---

## 9. Multilingual ruling

Author-supplied example phrases (e.g. escalation triggers like *"talk to someone"*, *"real person"*) are **operator data**, not code. The `no-keyword-lists` constitution constraint targets *code-level* English matching of product behavior; it does not forbid an operator from listing phrases, and a single-language agent may use that language. Such phrases ride as **few-shot examples on a semantic condition** (so the runtime still generalizes to paraphrases the author didn't enumerate). All **compile-time inference remains purely structural** (token presence, from-step kind, slot-reference tokens, sibling position, outline) — the prose's meaning is only ever evaluated at runtime. SC-007 (determinism) and SC-008 (no keyword lists) are preserved.

The **value-translation glossary** seen in real procedures (`GLAM_BAG → "Glam Bag"`) is **deferred** — later it becomes a typed glossary section or a directive, not parsed prose.

---

## 10. New requirements (extend the parent)

- **FR-015**: The authoring surface MUST be a structured document model with typed reference tokens for **Actions** and **Variables**, flow-target tokens for **step references / ends / handoff**, and a structured **counter** marker. Step `kind`, transition `guardKind`, and terminal `kind` MUST be **inferred** from tokens and document structure, not selected by the author.
- **FR-015a**: A step MUST be a **declared anchor** with a stable id that survives recompiles; jumps MUST be **step-reference tokens** to that id, never parsed from prose. The author-visible step label is free text in any language; the parser MUST NOT key on the literal word "Step" (Stable-Identity Rule / FR-011; SC-008).
- **FR-015b**: The document model MUST be a set of **typed sections** declaring their compile target; v1 implements only the routine/step section, with guidelines/glossary sections recognized as no-op placeholders for forward compatibility.
- **FR-016**: The document and the existing form MUST both be **total, lossless projections** of `RoutineDefinitionDraft`; no document text or AST may be persisted as a separate record; toggling re-projects from the draft. Round-trip identity (`draft→document AST→draft`, fixture `draft→text→parse→draft`) MUST be covered by tests.
- **FR-017**: Conditional branching MUST be derived structurally — a conditional produces a transition only when it resolves to a flow target (or nested declared step); otherwise it remains step-instruction nuance. The projection MUST render structured guards as structured rows/markers, never as prose.
- **FR-018**: `fork` MUST be removed from the step-kind enum; `always`/`fallback` SHOULD be unified into a single default-edge concept (separate schema-cut refactors).
- **FR-019**: Author-supplied example phrases MUST compile to few-shot examples on a semantic condition, never a literal/keyword match (reaffirms SC-008 for this surface).
- **FR-020**: The v1 authoring surface MUST be a structured outline editor: step cards with free-text labels and instructions, inline `@`-mentions for Variables/Actions, and explicit ordered branch rows (prose condition / outcome status / counter → target picker). It MUST expose **no** kind, guard-kind, terminal-kind, or per-step slot-type choices. No sigil syntax (`→`, `#id`, `[...]`, `↺`, `{#id}`) may appear in any author-facing surface, including diagnostics (which speak in step labels and branch positions).
- **FR-020a**: The canonical plain-text serialization (§14) is retained as an **engineer-facing fixture/debug format only** (golden tests, traces, docs examples). It MUST NOT ship as an editing surface.
- **FR-021**: The system MUST provide a **drafting assist**: free-prose SOP input → a proposed document draft emitted as schema-validated structured output, loaded into the outline editor for review, and subject to the standard validator before save. Assist output MUST NOT bypass validation and MUST NOT auto-publish. After a draft's first save, assist-proposed edits MUST preserve existing stable step/slot ids.
- **FR-021a**: LLM involvement is confined to the **authoring-assist layer**. The document→draft projection and draft→graph compile MUST remain purely structural and deterministic (re-affirms SC-007/SC-014; locates the parent constitution's "compiler parse pass" LLM integration at assist time).
- **FR-022**: The slice-5 form's retirement MUST follow the mechanical trigger in §6 (usage + zero-defect criteria → read-only → removal), tracked as a measurable criterion, not an open-ended deferral.
- **FR-023**: Handoff/end references MUST be flow-target tokens (step-reference family), distinct from `@` value/capability mentions.
- **FR-024**: A conditional that is neither in-step nuance nor resolves to a flow target MUST be rejected with an author-facing diagnostic offering the two valid resolutions (declare a step / fold into instruction) — never silently promoted or dropped.

## 11. New success criteria

- **SC-011**: A non-engineer authors the §8.4 routine **entirely in the outline editor** — without typing a single sigil and without choosing any kind/guard enum — publishes it, and it runs to completion with behavior equivalent to the form-authored version (Playwright-covered).
- **SC-012**: For a corpus of routines, `draft→document AST→draft`, fixture `draft→text→parse→draft`, and `draft→form→draft` are all identity (round-trip golden tests); structured guards survive as structured rows/markers.
- **SC-013**: A conditional with no flow target produces **no** transition (stays in-instruction); the same conditional with a target produces exactly one conditioned edge (branch-vs-nuance test).
- **SC-014**: No new English-keyword/regex product-vocabulary path is introduced by the parser or projection; all compile-time branch/kind inference is structural (re-verifies SC-008).
- **SC-015**: The drafting assist, given a realistic prose SOP (the contact-flow SOP as fixture), produces a draft that either validates or surfaces only author-term diagnostics; the resulting published routine compiles deterministically (SC-007 holds with assist in the loop).
- **SC-016**: The form-retirement trigger of §6 is instrumented: the count of document-path-authored routines and document-path defects is observable, so the read-only decision is mechanical.

---

## 12. Delivery split

1. **Document model + draft⇄document transform + fixture parser/serializer + source map + golden tests.** Pure `document ⇄ RoutineDefinitionDraft` transform with a `stableId → location` source map (so existing validator diagnostics, `location: scope:id`, map to document positions). The **document AST is the product artifact**; the plain-text grammar is its fixture serialization (FR-020a). The model is a set of **typed sections**, with only the routine/step section implemented (guidelines/glossary recognized as no-op placeholders, §3). Step anchors carry stable ids; jumps are step-reference tokens; flow-target taxonomy per FR-023; token-less-beat diagnostic per FR-024. Golden round-trip tests (SC-012/SC-013). No UI. *This is the durable core and where the design lives or dies.*
2. **Schema cuts.** Delete `fork`; unify `always`/`fallback` (runtime + migration + compiler/validator), each preserving parity. Includes the counter-exhausted-fallback runtime golden test (§8.3), since it pins the guard semantics the merge touches.
3. **Outline editor + toggle.** The structured outline editor over the slice-1 model; per-routine toggle with the existing form; save/blur → existing `/validate`; diagnostics mapped via the source map to step cards/branch rows. Playwright-covered (per the frontend constraint). Retirement-trigger instrumentation (SC-016).
4. **Drafting assist.** Prompt under `backend/prompts/routines/`; structured-output endpoint (admin/operator-authenticated, per the authoring API surface); review-before-apply flow in the editor; id-preservation on edit proposals; observability per §5. (Coach-pattern precedent.)
5. **Docs.** Rewrite `docs/authoring-routines.md` around: outline authoring, `@`-mentions, branch rows and precedence, branch-vs-nuance, the drafting assist, and the (form) interim. Fixture notation documented in engineer-facing docs only. (Docs are a deliverable; FR-014 / SC-010.)

*Post-v1: the rich-text editor with visual chips and the live branch-vs-nuance affordance — a pure front-end upgrade over slices 1–3, no model change. Then the Scope-B directive/glossary section handlers (verify the "section → artifact" split lines up with #664's scope-tag model before building).*

---

## 13. Open questions / risks

- **Outline editor ≈ "a better form"?** Acknowledged and accepted: the outline editor intentionally occupies the midpoint between the slice-5 form and the rich document. The claim under test is the §7 one — that removing the five enumerated choices (not the form-ness itself) is what makes authoring tractable. If SC-011 passes but authors still struggle, the rich editor is the next lever, and slices 1–2 carry over unchanged.
- **Assist quality bar.** What validation-failure rate on assist proposals is acceptable before it erodes trust? Start with the contact-flow SOP fixture as the regression benchmark; tune the prompt before widening.
- **Assist edit-mode scope.** v1 may restrict the assist to *initial* drafting (blank routine only), deferring "revise this existing routine from prose feedback" — which overlaps Coach's conversation-level coaching direction — to a later slice. Decide at slice-4 planning.
- **Fixture-notation drift.** With the grammar demoted to fixtures, guard against it quietly re-growing author-facing surface area (e.g. appearing in error messages). Diagnostics must speak in editor terms (step labels, branch positions), not fixture syntax (FR-020).
- **Scope B seam.** Still to verify before building the directive half: that the "section → artifact" split lines up with #664's scope-tag model.

---

## 14. Fixture notation (engineer-facing serialization)

The canonical text serialization of the document AST. **Not a product surface** (FR-020a): it exists for golden tests, debugging, diffs, and engineer docs. Because no author edits it, reflow-on-serialize is harmless and localization of its keywords is unnecessary (format grammar, not product vocabulary).

### 14.1 Sigil family

| Sigil | Means | Notes |
|---|---|---|
| `@name` | reference a **Variable** or **Action** | type resolved by name against the declared variable set and the registered-action set; a name in both sets is a validation error |
| `#id` | a **flow target** (step or end anchor) | declared on the anchor as `{#id}`, referenced by jumps and branches; handoff/ends are `#`-family targets (FR-023) |
| `→` | **transition** to a target | `→ #id` |
| `↺N` | **counter** bound on an edge | maps to `counterLimit` |
| `[ … ]` | an **edge guard marker** | `[<status>]` → outcome; `[needs @a, @b]` → slot_filled |
| `?` | **optional** variable in a declaration | absence ⇒ required (matches the draft default) |

### 14.2 Document shape

```
---
name: <routine name>
trigger: <activation condition, prose>
priority: <integer>
gate: <optional gate ref>
---

## Variables
- summary: text — one-line description of the problem
- severity: text — how badly it blocks them
- email: email — where we send updates
- order_id?: text — order number, if it's about an order

## Steps

1. Ask the visitor to describe the problem; capture @summary and how badly it
   blocks them as @severity.  {#gather}
   → #get_contact

2. Ask for an @email. If it's about an order, also ask for @order_id.  {#get_contact}
   → #create_ticket

3. Run @helpdesk_create_ticket with the details gathered.  {#create_ticket}
   → #confirm        [success]
   → #retry_ticket   [failure]
   → #handoff_human                       (default — fires after the conditioned siblings)

4. Tell the visitor we hit a hiccup and are retrying.  {#retry_ticket}
   → #create_ticket  ↺2                    (loop back, at most twice)
   → #handoff_human                        (default — once retries are exhausted)

## Ends
- confirm        [complete]: Confirm the ticket is open; we'll email updates to @email.
- handoff_human  [handoff]:  Apologize and hand the visitor to a human agent.
```

### 14.3 How each construct maps to `RoutineDefinitionDraft`

| Fixture text | Draft target |
|---|---|
| front-matter `name` / `trigger` / `priority` / `gate` | `name`, `activation.{triggerDescription, priority, gateRef}` |
| `- key: type — desc` (`key?:` ⇒ optional) | `slots[]` `{key, stableSlotId=key, type, required, description, ordinal}` |
| `@key` inside prose | `{{slot.key}}` in the stored `instruction` / `guardText` (serializer reverses `{{slot.x}}` → `@x`); a `@key` in a step instruction is also its capture point (drives `collectsSlots`) |
| numbered item + `{#id}` | `steps[]` `{stableStepId=id, instruction, ordinal}`; **kind inferred** — an `@action` mention in the step ⇒ `tool`/`action` (per the action catalog), else `chat` |
| `@action_ref` in a step | `step.toolRef` / `step.actionType` |
| `→ #id` (no marker) | transition `{toRef=id}`, guard = default (`always` if sole exit, else `fallback` — the §7 merge) |
| `if <prose> → #id` | guard `llm`, `guardText = <prose>` (verbatim) |
| `→ #id [status]` | guard `outcome`, `outcomeStatus = status` |
| `→ #id [needs @a, @b]` | guard `slot_filled` over `{a, b}` |
| `→ #id ↺N` | guard `counter`, `counterLimit = N` |
| `## Ends` `- id [complete\|handoff]: msg` | `terminals[]` `{stableStepId=id, kind, instruction=msg, ordinal}` |

`stableStepId`/`stableSlotId` are **frozen at first authoring** (slug of the initial label) and preserved verbatim across edits via the `{#id}` anchor, so relabeling never changes ids (Stable-Identity Rule / FR-015a). One guard marker per edge; combining `[…]` and `↺` and `if` on one edge is a validation error (one edge = one guard kind).

### 14.4 Decisions to finalize in slice 1

- **Counter × outcome interplay** — the precise semantics of a counter-bounded loop edge plus its fallback must match the slice-3a runtime guard behavior; pinned by the §8.3 golden runtime test (slice 2).
- **Nested sub-step notation** — the §8.4 example uses nested bullets that become nodes; the fixture grammar needs an explicit nested-anchor form (or requires flattening into anchored steps). Decide with the slice-1 round-trip tests; the *model* supports nesting either way.
