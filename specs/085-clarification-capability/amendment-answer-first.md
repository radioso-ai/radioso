# Amendment: Answer-First Clarification (relevance-aware confidence, soft-pick, original-intent carry)

**Parent**: `specs/085-clarification-capability/spec.md`
**Created**: 2026-06-12
**Status**: Design (pre-plan)
**Motivated by**: issue #686 — clarification over-triggers on unambiguous questions, presents menus of document titles, and drops the original question after the clarification round.
**Realizes**: the parent's promise in US2/SC-003 ("queries whose results are not meaningfully split answer immediately") which the shipped v1 does not keep, plus the parent's deferred middle ground between silent auto-pick and blocking ask.

---

## 1. Motivation

Issue #686 reproduces three failures on the retrieval-sense surface, each traceable
to a specific design gap in the shipped v1:

1. **Over-triggering: confidence measures corpus shape, not query fit.** Sense-group
   confidence is `(share + min(1, separation)) / 2`
   (`senseGroupingService.ts:275`) — the fraction of retrieved chunks from the
   document plus the embedding distance to other groups. Per-group
   `averageSimilarity` to the query is computed (`senseGroupingService.ts:205`) but
   used only for sort order; it never feeds confidence. Any two distinct,
   well-separated documents that both contribute ≥ `minGroupShare` of the top
   results therefore land within the ask margin of each other — even when the query
   is a near-verbatim match for one of them ("What is your refund policy?" against
   a document titled "Refund Policy"). The decision asks on *corpus structure*,
   blind to *query relevance*.
2. **Blocking is the only ask shape.** `ClarificationDecision` is
   `ask | auto_pick | none`; `ask` replaces the answer turn with a question. There
   is no way to answer with the best reading and offer the alternatives — every
   close call costs the visitor a full extra turn.
3. **The original question is dropped at resolution.** The pending record carries
   only the candidate set. On a chosen candidate, the resolution returns just a
   `documentScope` (`pendingClarificationResolver.ts:53-62`) and the resolving turn
   retrieves on the **reply text** ("Refund Policy", "Getting Started") filtered to
   the chosen documents. The visitor's actual question ("give me a curl example")
   is never the retrieval query, so the post-clarification answer addresses the
   chosen *document*, not the asked *question*. This defect exists in the shipped
   `ask` path independently of anything else in this amendment.

A fourth complaint — options phrased as document titles — is a label-prompt gap:
`clarification-sense-labels.md` receives titles/metadata and the candidate label
falls back to `group.documents[0].title` (`senseGroupingService.ts:168`), leaking
corpus structure instead of describing intents.

## 2. Design

### 2.1 Relevance-aware sense confidence

Sense-group confidence MUST incorporate the group's query relevance (the already-
computed average retrieval similarity) alongside share and separation, so that a
group that matches the query decisively clears the margin over a structurally
comparable but less relevant group, and the existing `clear_margin` auto-pick fires.
Exact weighting is a plan decision; the spec constraint is behavioral: a query that
is a strong match for one document's content answers immediately
(SC-009). Confidence stays ordinal within its candidate set (parent contract
unchanged).

### 2.2 Soft-pick: a third decision kind

`ClarificationDecision` gains `{ kind: "soft_pick", candidate, alternatives }`,
decided by a two-band policy generalizing today's single margin. The policy's
existing `margin` becomes `clearMargin`; a new `askMargin ≤ clearMargin` bounds the
inner band. The full decision order **preserves every parent rule** and inserts the
soft band only at the final step:

```
1. floor filter (parent FR-014); none remain            → none
2. suppressed-ask mode (active routine, parent FR-010)  → auto_pick (suppressed)
3. gap to runner-up ≥ clearMargin                       → auto_pick (clear_margin)
4. too-close set = within clearMargin of leader, capped at maxOptions
5. loop guard: same set as last asked OR offered        → auto_pick (loop_guard)
6. unique highest authored priority in too-close set    → auto_pick (priority)
7. gap to runner-up ≥ askMargin                         → soft_pick (top, rest)  ← new
8. otherwise                                            → ask
```

Suppression, loop guard, and priority arbitration therefore all outrank the soft
band, exactly as they outrank `ask` today. **`askMargin = clearMargin` yields an
empty soft band and reproduces today's behavior bit-for-bit** — that is how routine
activation's policy stays unchanged (FR-021): its default sets the two margins
equal; no code path is disabled, the band is simply empty.

- **Turn behavior**: unlike `ask`, `soft_pick` does **not** short-circuit the turn.
  It behaves as `auto_pick` for grounding (the winner's `documentScope` constrains
  the answer — answers never blend senses) *and* carries the runner-up candidates
  forward. The answer-generation prompt receives the alternatives as structured
  labels with an instruction to offer them briefly at the end, in the conversation
  language. The offer copy comes from the LLM — no hard-coded strings (parent
  constitution constraint).
- **Pending state**: a `soft_pick` turn saves a pending clarification with
  `mode: "offer"` via the same deferred-commit store; the offer commits atomically
  with the answer turn. The single-pending invariant holds unchanged.
- **Lenient resolution — explicit amendment of parent FR-006**: on the next
  message, an `offer`-mode pending resolves through the existing reply mapper, but
  `declined`/`unrelated` clears silently and the turn proceeds as a completely
  normal turn — no decline messaging, and **no suppression of new clarification**.
  This deliberately relaxes the parent's resolve-never-creates invariant (parent
  FR-006, data-model invariants) **for offer mode only**: an ignored offer was
  never a question, so the new message may legitimately clarify or offer on its own
  merits. `ask`-mode resolution keeps the parent invariant unchanged. Two guards
  bound the relaxation: the single-pending invariant still holds (the lenient clear
  and any new save commit in the same turn transaction, clear-before-save), and the
  loop guard treats an offered set like an asked set — the identical candidate set
  is never offered or asked twice consecutively. Only `chosen` triggers the
  continuation (§2.3).
- **Per-surface policy**: the band is policy-owned per surface, as in the parent.
  v1 of this amendment enables `soft_pick` for **retrieval sense only**; routine
  activation keeps its current `ask` behavior unchanged — soft-picking a routine
  would *execute* it, which is not "answer with best match". Defaults MUST make
  blocking `ask` the rare case on retrieval sense (exact `askMargin`, possibly 0,
  is a plan decision).

### 2.3 Original-intent carry

- The pending record gains the **originating user message** (`originalQuery`): the
  message whose turn produced the candidates. This applies to **both** `ask` and
  `offer` modes — it fixes the shipped intent-drop bug in the blocking path too.
- On a `chosen` resolution for retrieval sense, the resolution handler returns
  `{ documentScope, originalQuery }`, and the resolving turn MUST run retrieval and
  answer generation against the **original question** scoped to the chosen
  documents — the reply text serves only to select the candidate. The clarifying
  exchange remains in history as normal context.
- **Data-class and retention**: `originalQuery` is visitor message content — this
  widens the parent plan's claim that pending rows store "candidate labels/ids and
  document ids only" (plan.md customer-data note), so the parent data-model and
  plan notes MUST be updated in the same change. Retention is minimal: the value
  is needed only by the resolving turn, so it MUST be nulled when the record
  leaves `pending` status (resolved/declined/expired — the loop guard reads only
  candidate ids and never needs it), and the existing TTL/cleanup path bounds the
  pending window itself. It MUST NOT appear in traces or telemetry (parent
  FR-011/FR-012 discipline unchanged), covered by an explicit exclusion test.

### 2.4 Intent-phrased options

Candidate labels presented to visitors (in `ask` questions and `soft_pick` offers)
MUST be phrased as readings of the visitor's intent, never bare document titles. The
sense label prompt receives the visitor's question alongside the group
titles/metadata and is instructed to describe *what the visitor might be asking
about*. When LLM labeling fails for any presented candidate, the system MUST NOT
fall back to titles and MUST NOT block the turn: it auto-picks the top candidate
silently and answers (consistent with this amendment's answer-first bias),
recording the fallback in the trace stage (`label_fallback`) so over-reliance is
operator-visible. Document titles remain internal data (trace, payloads) only.

## 3. Boundary rules

- **Contract** (`packages/conversation-contract`): the new decision kind, the
  two-band policy fields, and `mode`/`originalQuery` on `PendingClarification` are
  contract-level. The Clarifier remains payload-opaque and surface-ignorant.
- **Engine** (`packages/conversation-engine`): owns the band decision in
  `decideClarification` and the new trace decision name `"offered"`. The engine
  gains no knowledge of retrieval or answer composition.
- **Backend**: owns the confidence formula (retrieval module), prompt assets
  (`backend/prompts/chat/`), the `clarification_states` migration
  (`mode`, `original_query`), the resolution handler's
  original-query continuation, and metrics. Chat orchestration routes the
  soft-pick annotation into answer composition but contains no policy thresholds
  (parent Encapsulation Rule).
- **Kit parity**: the standalone conversation kit re-exports clarification; the
  contract additions MUST be reflected there in the same change.
- **Anti-goals**: no structured option chips / quick-reply UI (parent anti-goal
  stands; the offer is woven into the answer text); no per-agent tuning UI for the
  bands; no `soft_pick` for routine activation in this amendment; no second
  commit discipline; no answer grounded in a blend of candidate senses.

## 4. New requirements (extend the parent)

- **FR-015**: Retrieval-sense candidate confidence MUST incorporate the group's
  query relevance (average retrieval similarity) in addition to share and
  separation, such that a decisive query-fit winner auto-picks via the existing
  clear-margin rule. Confidence remains ordinal within its candidate set.
- **FR-016**: The Clarifier MUST support a third decision outcome, `soft_pick`,
  selected by a per-surface two-band closeness policy following the exact decision
  order in §2.2 — floor, suppressed-ask, clear margin, loop guard, and priority
  arbitration all decide before and outrank the soft band, preserving parent
  FR-010/FR-014 and the parent's deterministic ordering. A `soft_pick` turn MUST
  produce a normal answer grounded only in the top candidate's material and
  present the remaining too-close candidates as an LLM-phrased inline offer in the
  conversation language. A policy with `askMargin = clearMargin` MUST reproduce
  pre-amendment behavior exactly.
- **FR-017**: A `soft_pick` turn MUST persist a pending clarification with
  `mode: "offer"` under the existing deferred-commit and single-pending rules.
  Offer-mode resolution MUST be lenient: `chosen` → the surface continuation;
  `declined`/`unrelated` → silent clear, normal turn, no decline messaging, and no
  suppression of legitimately new clarification on the new message. **This amends
  parent FR-006 and the data-model resolve-never-creates invariant for offer mode
  only**: a turn that leniently clears an offer MAY save a new clarification for
  the new message within the same turn transaction (clear-before-save, single
  pending at commit); `ask`-mode resolution keeps the parent invariant verbatim.
  The loop guard MUST treat offered sets like asked sets: the same candidate set
  is never offered or asked twice consecutively.
- **FR-018**: The pending clarification record MUST carry the originating user
  message for both `ask` and `offer` modes. On a chosen retrieval-sense
  resolution, the resolving turn MUST retrieve and answer against the original
  question constrained to the chosen candidate's documents; the visitor's reply
  serves only to select the candidate. The stored message MUST be nulled when the
  record leaves `pending` status, MUST NOT appear in traces or telemetry (covered
  by an explicit exclusion test), and the parent data-model/plan customer-data
  notes MUST be updated to reflect the widened data class.
- **FR-019**: Visitor-facing candidate labels MUST be phrased as intent readings
  derived from the visitor's question plus group titles/metadata; bare document
  titles MUST never be presented to visitors. On labeling failure the system MUST
  auto-pick the top candidate silently instead of presenting unlabeled options,
  recording `label_fallback` in the trace stage.
- **FR-020**: The `offered` decision MUST appear as a first-class clarification
  trace stage (candidates, bands, chosen winner) rendered in the conversation
  debug turn-flow view, and MUST be countable in operations metrics alongside the
  parent's decision outcomes, including offer-resolution outcomes
  (accepted-alternative / ignored).
- **FR-021**: Routine-activation clarification behavior is unchanged by this
  amendment: its default policy MUST set `askMargin = clearMargin` (empty soft
  band, pre-amendment behavior bit-for-bit), and all parent routine-activation
  scenarios continue to hold.

## 5. New success criteria

- **SC-009**: The #686 repro set no longer clarifies: "What is your refund
  policy?" against a corpus containing "Refund Policy" and "Shipping FAQ" answers
  immediately, grounded in the refund document, with no clarifying question
  (verified by integration test with both documents ingested).
- **SC-010**: On a genuinely ambiguous query in the soft band, the visitor
  receives a grounded answer for the strongest reading **and** an inline offer of
  the alternative in the same turn; replying with the alternative yields an answer
  to the **original question** grounded only in the alternative's material
  (verified via citations).
- **SC-011**: In the shipped blocking path, choosing a clarification option now
  answers the original question, not the option label: the parent US2 journey with
  a specific question ("…give me a curl example") produces an answer addressing
  that question after the choice.
- **SC-012**: Ignoring an inline offer costs nothing: the next unrelated message
  is handled as a fully normal turn with no decline messaging, no suppressed
  clarification, and no re-offer of the same set.
- **SC-013**: No visitor-facing clarification or offer presents bare document
  titles as options on the test corpus; a forced labeling failure produces a
  silent auto-pick with a `label_fallback` trace record, never unlabeled or
  title-labeled options.
- **SC-014**: Parent SC-001 and SC-003 through SC-008 continue to pass;
  routine-activation suites pass unchanged. **Parent SC-002 is amended** by this
  amendment's banding: soft-band ambiguous queries produce answer-plus-offer
  (SC-010) instead of a blocking question; only inner-band ambiguity
  (gap < `askMargin`) still blocks with a question. SC-002's second half — the
  post-choice answer is grounded only in the chosen sense — holds for both
  resolution paths. The parent quickstart's US2 journey MUST be updated to the
  banded expectation in the same change.

## 6. Delivery split

1. **Relevance-aware confidence (backend, TDD).** Fold query relevance into
   `confidenceFor`; recalibrate against the existing sense-grouping unit suite and
   add the #686 repro corpus as an integration case (SC-009). No contract change;
   independently shippable and already most of the user-visible win.
2. **Original-intent carry for the existing `ask` path.** Migration adds
   `original_query` (and `mode`, defaulted to `ask`) to `clarification_states`,
   nulled on leaving `pending`; resolution handler returns it; resolving turn
   retrieves on it (SC-011); trace/telemetry exclusion test; parent data-model and
   plan customer-data notes updated. Fixes the shipped bug before soft-pick lands;
   kit re-export updated.
3. **`soft_pick` contract + engine band decision (TDD).** Contract kind, two-band
   policy, engine decision + `"offered"` trace stage; per-surface defaults wired in
   composition (retrieval sense only).
4. **Answer-with-offer turn flow.** Offer-mode pending save on soft-pick turns,
   alternatives into answer composition via prompt assets, lenient resolution,
   metrics (SC-010, SC-012).
5. **Intent-phrased labels.** Sense-label prompt receives the visitor question;
   phrasing requirement + fallback trace visibility (SC-013).
6. **Operator surface + docs.** Turn-flow/stage-detail rendering of `offered`
   (frontend unit transform tests + existing trace Playwright journey); retrieval
   settings/behavior docs updated for answer-first clarification; parent
   quickstart US2 journey updated to the banded expectation (SC-014).

## 7. Open questions / risks

- **Confidence weighting and band defaults**: exact relevance weighting and
  `clearMargin`/`askMargin` values per surface are plan decisions; the spec
  constraints are SC-009 (repro answers immediately) and `ask` being rare on
  retrieval sense. Whether retrieval-sense `askMargin` should be 0 (never block)
  is explicitly open.
- **Offer placement in answer composition**: alternatives as a prompt block in the
  main answer call vs. a separate trailing segment — plan decision; one model call
  is strongly preferred (latency memory: serial round-trips are the chat latency
  root cause).
- **Soft-pick × routine activation interplay**: clear-before-save within the turn
  transaction is now pinned (FR-017); the remaining plan-level check is that the
  routine-activation detector runs against the post-clear state so an ignored
  retrieval offer never masks a legitimate routine clarification.
- **Recalibration blast radius**: changing `confidenceFor` shifts existing
  auto-pick/ask boundaries; the parent's unambiguous and yoga-corpus test sets
  must be re-run as the regression net (SC-014).
