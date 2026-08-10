# Feature Specification: Clarification Capability

**Feature Branch**: `085-clarification-capability`
**Created**: 2026-06-10
**Status**: Draft (revision 2 — contracts pinned per review)
**Input**: User description: "Generic clarification (disambiguation) capability: shared Clarifier + per-source detectors so the assistant asks instead of guessing when matching produces comparable candidates (routine activation, retrieval sense). Item 2 of issue #667; design direction in `.context/clarification-generic.md`."

> "Clarification" is our product name for what the literature calls **disambiguation**
> (Amazon Lex, Copilot Studio, Parlant). Distinct from **slot-filling**: slot-filling
> collects a *missing* value a routine declared it needs; clarification chooses among
> *two or more comparable candidates* that already matched. This spec is only about
> the second.

## Problem

When a matching/resolution step produces two or more comparable candidates, the
assistant silently guesses — and guesses wrong on the close calls (wrong routine
started, answer grounded in the wrong sense of an ambiguous corpus term). The fix is
the same everywhere: **don't guess — ask the user, map the reply, resume.** Today no
shared mechanism for this exists, and multiple surfaces need it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Routine activation clarification (Priority: P1)

An agent has several published routines whose triggers can overlap (e.g. "book a
demo" and "book a support call"). A visitor writes a message that plausibly matches
more than one. Instead of silently starting one of them (and being wrong half the
time), the assistant asks one short clarifying question naming the comparable
options, the visitor answers in their own words, and the chosen routine starts
normally. When one routine clearly dominates, no question is asked and behavior is
unchanged from today.

This story includes the prerequisite it stands on: routine activation must evaluate
all candidate routines **together** and produce a ranked candidate list with
confidence levels, instead of today's one-by-one first-match short-circuit. (Issue
#667 describes this seam as already preserved; in the current code it is recorded as
an obligation but **not implemented** — activation still short-circuits and its cost
grows with each published routine. Building the ranked matcher is in scope here; its
contract is pinned in "Capability Contracts" below.)

**Why this priority**: It is the documented failure mode that motivated the feature
(false routine activation), it forces the shared Clarifier, the pending-clarification
conversation state, and the ranked activation matcher into existence, and it is
independently shippable end-user value.

**Independent Test**: Publish two routines with overlapping triggers on one agent.
Send an ambiguous message — assistant asks, naming both options; reply with a choice
— the chosen routine starts at its first step. Send a clearly-targeted message — the
matching routine starts with no question asked.

**Acceptance Scenarios**:

1. **Given** an agent with two published routines whose triggers overlap, **When** a
   visitor sends a message that matches both comparably, **Then** the assistant asks
   a single clarifying question that presents both options in the conversation
   language, and no routine starts on that turn.
2. **Given** a pending routine clarification, **When** the visitor's next message
   indicates one of the offered options (in their own words, any supported language),
   **Then** that routine starts at its first step exactly as if it had been activated
   directly, including any activation-time variables extracted from the original
   ambiguous message.
3. **Given** a pending routine clarification, **When** the visitor replies that none
   of the options is what they want, **Then** the assistant abandons the candidates
   and handles the message as a normal turn (no routine starts, no re-ask of the
   same question).
4. **Given** a pending routine clarification, **When** the visitor replies with an
   unrelated message (changes topic), **Then** the pending clarification is dropped
   and the message is handled as a normal turn.
5. **Given** an agent where one routine's trigger clearly dominates for a message,
   **When** the visitor sends that message, **Then** the routine starts immediately
   with no clarifying question (no behavior change versus today).
6. **Given** an agent with many published routines, **When** any message arrives,
   **Then** activation is decided with a single activation model call over all
   candidates — no per-routine model calls and no sequential per-routine model
   latency the way today's one-by-one checks incur (prompt size still grows with
   routine count; call count does not).
7. **Given** two routines matching comparably where one has a higher authored
   activation priority, **When** a visitor sends an ambiguous message, **Then** the
   higher-priority routine activates silently — authored priority is the operator's
   explicit arbitration, and clarification only fires when comparable candidates
   also tie on priority.

---

### User Story 2 - Retrieval sense clarification (Priority: P2)

A workspace corpus covers two distinct senses of the same term (the canonical
example: *hatha yoga* and *raja yoga* documents). A visitor asks "tell me about
yoga". Instead of picking one sense and grounding the answer in it — sometimes
wrongly — the assistant notices the corpus offers clearly distinct senses, asks which
one the visitor means, and then answers grounded in the chosen sense. Queries whose
results are not meaningfully split answer immediately, exactly as today.

Sense candidates come **from the retrieved data** (the top results separating into
distinct groups), never from an authored or hard-coded term list. The detector
contract is pinned in "Capability Contracts" below.

**Why this priority**: It is the cross-cutting consumer that justifies the generic
shape (it fires with **no routine active**, proving clarification is a turn-level
capability, not a routine feature). It depends on the Clarifier from US1 but delivers
independent value on corpora with ambiguous terminology.

**Independent Test**: Ingest documents covering two distinct senses of one term into
a workspace. Ask about the term — assistant asks which sense; choose one — the answer
cites only material from the chosen sense. Ask an unambiguous question — answered
immediately with no question.

**Acceptance Scenarios**:

1. **Given** a corpus containing two clearly distinct senses of a term, **When** a
   visitor asks about that term without indicating a sense, **Then** the assistant
   asks one clarifying question naming the senses it found, phrased in the
   conversation language.
2. **Given** a pending sense clarification, **When** the visitor picks a sense,
   **Then** the assistant answers grounded in material for the chosen sense, and the
   answer does not mix in the other sense's material.
3. **Given** a query whose top results do not split into distinct senses, **When**
   the visitor asks it, **Then** the assistant answers immediately with no
   clarifying question (no behavior change versus today).
4. **Given** a pending sense clarification, **When** the visitor replies that
   neither sense is meant, or changes topic, **Then** the assistant proceeds with a
   best-effort normal answer to their latest message and does not re-ask the same
   question.
5. **Given** the standalone (non-conversational) retrieval answer surface, **When**
   an ambiguous query arrives, **Then** behavior is unchanged from today — there is
   no conversation to resume, so clarification never fires there.
6. **Given** a conversation with an active routine whose turn yielded as off-topic
   to normal answering, **When** that off-topic query is sense-ambiguous, **Then**
   the assistant does **not** ask — it auto-picks the strongest sense, answers
   best-effort, and records the suppressed ask in the trace (see "Active routine
   suppression" under Capability Contracts).

---

### User Story 3 - Operator explainability (Priority: P3)

An operator reviewing a conversation in the debug/workbench view can see every
clarification decision: which candidates were considered, how close they were,
whether the system auto-picked silently or asked (or suppressed an ask), and which
candidate the visitor's reply mapped to. Silent auto-picks on close-but-decidable
calls are visible too, so operators can judge whether the system asks too often or
guesses too much.

The existing turn-flow debug graph builds its nodes from an explicit set of known
stage kinds — a new stage does not appear by itself. This story therefore includes
the frontend work to render clarification as a first-class node, with tests.

**Why this priority**: Explainability is the operational half of the feature —
without it, operators cannot tune content/routines or trust the new behavior — but
it is consumed by operators, not end users, and depends on US1/US2 existing.

**Independent Test**: Drive an ambiguous and an unambiguous conversation turn, open
the conversation's debug trace as an operator, and verify both decisions are visible
as nodes in the turn-flow view with candidates and outcome in the detail panel.

**Acceptance Scenarios**:

1. **Given** a turn where clarification was asked, **When** an operator opens the
   conversation trace, **Then** the turn-flow graph shows a clarification node, and
   its detail shows the candidate set (labels and closeness), the decision "asked",
   and — after the visitor replies — which candidate was chosen (or that the visitor
   declined all).
2. **Given** a turn where a clear winner was auto-picked (or an ask was suppressed
   because a routine was active), **When** an operator opens the trace, **Then**
   they see the candidates and that the top one was auto-picked, with the reason
   (clear margin / priority arbitration / suppressed ask).
3. **Given** any clarification trace content, **Then** it contains candidate labels
   and decision data only — no raw document content, prompts, or credentials.

#### UI Tasks

- Render the clarification stage as a first-class node in the conversation debug
  turn-flow view (currently the graph derives nodes only from known stage kinds).
- Show clarification details in the stage detail panel: candidates with labels and
  closeness, decision (asked / auto-picked / suppressed), reply-mapping outcome.
- Cover the graph/detail transformation with frontend unit tests (data transform,
  non-visual) and the visible operator journey with the existing trace-view
  Playwright coverage.

---

### Edge Cases

- **Repeated ambiguity (loop guard)**: the same clarifying question is never asked
  twice in a row in a conversation. If the reply fails to map to a candidate once,
  the assistant proceeds best-effort instead of re-asking.
- **Too many candidates**: when more than a presentable number of candidates are
  comparable (default cap: 4), only the strongest are offered.
- **All candidates weak**: if no candidate clears a minimum-confidence floor, the
  turn behaves as if nothing matched (no clarification among uniformly bad options).
- **Abandoned clarification**: pending clarification state expires after a bounded
  time (consistent with how in-flight routine state expires); an expired pending
  question is simply never resumed.
- **Active routine**: while a conversation has active routine state, clarification
  never asks (see "Active routine suppression" contract). The deferred step-input
  detector is where in-routine clarification will be designed.
- **Persistence failure mid-turn**: if the turn fails after the clarifying question
  is generated but before the turn commits, no pending clarification state survives
  (ask state commits atomically with the assistant turn — see contract below); the
  next turn behaves as if the question was never asked.
- **Channel coverage**: works on every conversational surface (dashboard chat,
  website embed, assistant API channels) because the question is an ordinary
  assistant message and the reply is ordinary visitor text. Non-conversational
  surfaces (standalone retrieval answers, document search) never clarify.
- **Multilingual**: question phrasing and reply mapping must work in the
  conversation's language; reply mapping must accept free-text answers ("the second
  one", "hatha", "не то и не другое"), not just option labels.

## Capability Contracts *(mandatory for this feature)*

These contracts are the composability spine of the feature. Planning may refine
naming and placement, but MUST NOT weaken the responsibility split.

### Clarifier ↔ Detector responsibility split

The Clarifier **cannot and must not** "activate a routine" or "re-run retrieval".
The split is:

- **Detector (per surface)** owns: producing candidates (including an **opaque
  payload** per candidate that carries everything its surface needs to act on a
  choice — e.g. extracted activation variables for a routine, or the member-document
  references of a sense group); and **applying** a resolution (activating the chosen
  routine; constraining the answer to the chosen sense). Detectors register with
  their surface, not with the Clarifier.
- **Clarifier (shared, generic)** owns: the closeness decision (auto-pick vs ask vs
  suppressed), LLM question phrasing from labels/descriptions, persistence of the
  pending clarification, LLM reply mapping to a candidate id, the loop guard, and
  the trace record. It treats candidate payloads as opaque bytes and never
  interprets them.
- **Resolution handoff**: when a pending clarification resolves to a candidate, the
  turn flow routes the resolution — chosen candidate id + its stored opaque payload
  — back to a **resolution handler owned by the originating surface** (identified by
  the pending record's source). The Clarifier's job ends at "candidate chosen /
  declined / abandoned"; what happens next is the surface's continuation. Each
  surface's handler receives the resolution at the start of the turn, before normal
  selection, and continues its flow (start routine at first step; answer constrained
  to the sense group).

### Candidate shape

A clarification candidate is `{ id, label, description?, confidence, payload }`
where `payload` is opaque to the Clarifier and owned by the detector. `confidence`
is a 0–1 value whose semantics are **ordinal within a single candidate set** (it
ranks candidates and feeds the closeness test); cross-surface or cross-turn
comparison of confidences is undefined and MUST NOT be relied on.

### Pending clarification store and atomic commit

- A narrow conversation-scoped store port with exactly three operations:
  **loadPending**(conversation) → at most one pending clarification; **save**(pending);
  **clear**(conversation). The pending record holds: originating source identifier,
  the presented candidate set (with payloads), the asked-question turn reference,
  and an expiry consistent with in-flight routine state lifetime.
- **Deferred commit (same model as routine state)**: in-flight chat already defers
  routine-state saves/clears until the turn's effects are durably enqueued
  (command-capture, flushed at turn commit). The pending-clarification store MUST
  participate in the **same turn-commit discipline**: the *ask* (save) commits
  together with the assistant turn that contains the question; the *resolution*
  (clear, plus the surface's continuation effects) commits with the turn that
  consumed the reply. If the turn fails before commit, neither the question's
  pending state nor a half-applied resolution survives.
- **Single-pending invariant**: at most one pending clarification per conversation,
  ever. A turn that resolves one pending clarification MUST NOT create a new one in
  the same turn (covered also by the loop guard).

### Ranked routine activation matcher

Replaces the sequential per-routine yes/no checks with **one model evaluation** for
the turn:

- **Input**: the visitor message (with turn context) and the full eligible routine
  list, each entry carrying its id, authored trigger description, and authored
  activation priority.
- **Eligibility before ranking**: capability gates (a routine's authored gate
  reference) filter routines out **before** the model evaluation — a gated-off
  routine is never a candidate and never appears in a clarifying question.
- **Output**: one structured result with a per-routine entry:
  `{ routineId, confidence (0–1), activationVariables? }` — variables the model can
  already extract from the message are captured per candidate so a later clarified
  choice preserves them (they travel in the candidate payload).
- **Confidence semantics**: ordinal likelihood that this routine's trigger is what
  the visitor wants; used for ranking and the closeness test only.
- **Priority interaction**: authored priority is the operator's explicit
  arbitration. Decision order: (1) drop candidates below the confidence floor;
  (2) if the top candidate clears the closeness margin over the runner-up →
  activate it silently; (3) if too close but a **unique highest authored priority**
  exists among the too-close set → activate that one silently (trace records
  "priority arbitration"); (4) otherwise → clarify among the too-close set.
- **Determinism**: ordering everywhere (ranking ties, presented option order) is
  stable — confidence desc, then authored priority desc, then routine id. Equal
  confidence and equal priority can never silently auto-pick (they are by
  definition too close).
- **No-routine outcome**: if no candidate clears the floor, activation declines the
  turn exactly as today (normal selection proceeds).

### Retrieval sense detector

- **Where it runs**: inside the conversational retrieval turn, **after** retrieval
  has produced its ranked result set for the interpreted query and **before** the
  grounded answer is composed. It never runs on the standalone retrieval answer
  surface or non-conversational tools.
- **Grouping method (v1)**: partition the top retrieved results into candidate
  sense groups using the data the results already carry — document identity and
  document-level metadata first, with semantic separation (embedding distance
  between groups) as the cohesion check. A grouping qualifies as a sense split only
  when at least two groups each hold a material share of the top results and the
  groups are semantically separated; otherwise the detector stays silent. No term
  lists, no language-specific logic.
- **Candidate construction**: one candidate per qualifying group —
  `label`/`description` generated by the LLM from the group's document titles and
  metadata (multilingual-safe; never concatenated raw chunk text); `confidence` =
  the group's share/cohesion score (ordinal); `payload` = the group's member
  document/chunk references.
- **Applying a choice**: the chosen sense constrains grounding — the answer for the
  resolving turn is grounded only in the chosen group's material (by restricting to
  the payload's document references and/or re-querying with that restriction). The
  constraint applies to the resolving turn; subsequent turns are interpreted
  normally (conversation context naturally carries the chosen sense).

### Active routine suppression

While a conversation has **active routine state** — including turns the routine
yields as off-topic to normal answering — clarification operates in
**suppressed-ask mode**: detectors may detect and the trace records the candidate
set, but the Clarifier always auto-picks the top candidate silently (decision
recorded as "suppressed"). Rationale: pending clarification and active routine
state must never compete to interpret the visitor's next message
(single-pending-interaction invariant). In-routine clarification arrives with the
deferred step-input detector, which must be designed together with routine
pause/resume.

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- All clarifying questions and reply interpretations are user-facing conversational
  behavior and MUST be produced by the LLM from candidate labels/descriptions —
  never hard-coded application strings (multilingual requirement).
- Detection of ambiguity MUST NOT use English keyword lists, term glossaries baked
  into code, or language-specific regexes; candidates come from structured data
  (confidence-ranked matches, result grouping).
- New runtime prompt assets MUST live under `backend/prompts/`.
- Backend development MUST follow TDD: tests written and failing before
  implementation.
- Frontend user-visible behavior MUST prefer Playwright coverage; frontend unit
  tests MUST stay focused on non-visual logic (the turn-flow graph transform
  qualifies; its rendering journey is Playwright's).
- Secrets and keys MUST live in `.env`; `.env.example` updated if new configuration
  is introduced.
- Modular boundaries between transport, orchestration, domain logic, and persistence
  MUST be preserved (see Architecture Constraints).
- Message-queue impact review: this feature changes no worker payloads, queue
  contracts, or document-worker dispatch. Pending-clarification state is
  conversation-scoped request-path state committed with the turn, like in-flight
  routine state. If planning discovers any queue contact, the plan must revisit
  this review.
- Observability: clarification decisions are a new runtime path and MUST be traced
  (US3) and countable (asked vs auto-picked vs suppressed vs mapped/declined/
  expired) without recording raw prompts, completions, or document content.

## Architecture Constraints *(mandatory)*

- **Boundary Rule — Clarifier is generic and primary**: the Clarifier is a
  turn-level capability of the conversation engine layer. It knows nothing about
  routines or retrieval — it consumes only the candidate shape defined above plus a
  closeness policy, and treats payloads as opaque. It MUST be reachable from a
  normal answer turn, because the retrieval case fires with no routine active.
  Clarification is **not** modeled as a routine.
- **Boundary Rule — Detectors are surface-owned**: each detector and its resolution
  handler live with their surface and depend only on the narrow Clarifier port:
  routine-activation detection in the routine activation path; sense detection
  inside the retrieval module's pipeline. Neither detector's vocabulary leaks into
  the Clarifier.
- **Encapsulation Rule**: the chat orchestration service remains orchestration-only —
  it may route a turn into/out of clarification but MUST NOT contain candidate
  scoring, question phrasing, reply mapping, or policy thresholds. Retrieval's
  query-rewrite service remains a query-interpretation concern and MUST NOT own
  pending-clarification state. The deferred-commit wrapper for pending state
  follows the existing command-capture pattern rather than introducing a second
  commit discipline.
- **New Seams Required**:
  - The Clarifier port + default implementation in the conversation engine layer
    (contract + engine packages).
  - The pending-clarification store port + deferred-commit participation in the
    chat turn lifecycle (host side).
  - The ranked multi-routine activation matcher (one evaluation, structured output)
    replacing the sequential short-circuit (fulfils the 082 plan's recorded seam
    obligation).
  - The sense-grouping detector + answer-constraining continuation in retrieval.
  - A clarification trace stage on the turn trace spine (additive) **and** its
    first-class rendering in the frontend turn-flow graph and stage detail panel.
- **Anti-Goals**:
  - Do not build clarification as a routine or inside the routine runner.
  - Do not let the Clarifier interpret candidate payloads or call surface logic
    directly; resolution flows through the surface-owned handler.
  - Do not add per-agent settings UI, authoring surfaces, or a term/sense glossary
    in this feature; closeness policy ships as per-surface system defaults.
  - Do not introduce structured option chips / quick-reply UI in this feature; the
    question is a plain assistant message (chips are a candidate fast-follow).
  - Do not encode senses, trigger phrases, or option-matching vocabulary in code.
  - Do not let the engine package gain knowledge of retrieval, or the retrieval
    module gain knowledge of routines.
  - Do not invent a second turn-commit mechanism for pending state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a single generic clarification mechanism
  (Clarifier) that accepts a ranked candidate set in the shape defined under
  Capability Contracts and a closeness policy, and decides: auto-pick the top
  candidate (clear winner), ask the user (too close), or suppressed auto-pick
  (active routine). The Clarifier MUST NOT interpret candidate payloads or contain
  any routine- or retrieval-specific logic.
- **FR-002**: Closeness policies MUST be defined per consuming surface (routine
  activation; retrieval sense) as system defaults, comprising a top-vs-runner-up
  closeness test, a minimum-confidence floor below which candidates are ignored,
  and a cap (default 4) on options presented. No operator-facing tuning UI ships in
  this feature.
- **FR-003**: When clarification is asked, the question MUST be generated by the
  LLM from the candidate labels/descriptions in the conversation's language, as an
  ordinary assistant message, and the turn MUST NOT execute any candidate.
- **FR-004**: The system MUST persist at most one pending clarification per
  conversation via the store port defined under Capability Contracts, with the
  ask committing atomically with the assistant turn that contains the question,
  the resolution committing with the turn that consumed it, and a bounded lifetime
  consistent with in-flight routine state. A turn failure before commit MUST leave
  no pending state and no half-applied resolution.
- **FR-005**: On the next visitor message while a clarification is pending, the
  system MUST interpret the reply (LLM-based, free text, multilingual) into exactly
  one of: a chosen candidate; an explicit "none of these"; or an unrelated message.
  Chosen → the resolution (candidate id + opaque payload) is handed to the
  originating surface's resolution handler, which continues its flow. None /
  unrelated → clear the pending state and handle the message as a normal turn.
- **FR-006**: The system MUST never ask the same clarifying question twice
  consecutively in a conversation (loop guard); after one failed mapping or a
  decline, it proceeds best-effort. A turn that resolves a pending clarification
  MUST NOT create a new one.
- **FR-007**: Routine activation MUST follow the ranked matcher contract defined
  under Capability Contracts: gate-filtered eligibility, one structured model
  evaluation over all eligible routines with per-routine confidence and extracted
  activation variables, the priority-aware decision order (floor → margin →
  unique-priority arbitration → clarify), deterministic ordering, and preservation
  of activation variables through a clarified choice.
- **FR-008**: Conversational retrieval MUST follow the sense detector contract
  defined under Capability Contracts: post-retrieval grouping of top results by
  document identity/metadata with semantic-separation checks, LLM-derived group
  labels, group references as opaque payload, and — on a chosen sense — grounding
  the resolving turn's answer only in the chosen group's material. Sense derivation
  MUST come from the data, never from authored or hard-coded term lists.
- **FR-009**: Clarification MUST operate only on conversational surfaces (dashboard
  chat, website embed, assistant API channels). Non-conversational surfaces —
  standalone retrieval answers, document search, MCP retrieval tools — are
  unchanged.
- **FR-010**: While a conversation has active routine state (including yielded
  off-topic turns), clarification MUST operate in suppressed-ask mode: detectors
  may run, the trace records candidates and the suppression, and the top candidate
  is auto-picked silently.
- **FR-011**: Every clarification decision (auto-pick, ask, suppressed — with
  candidates and closeness; and the later reply-mapping outcome) MUST appear as a
  distinct stage in the conversation turn trace, and the frontend conversation
  debug view MUST render it as a first-class node in the turn-flow graph with a
  detail panel (US3 UI Tasks), excluding raw document content and prompts.
- **FR-012**: Clarification activity MUST be countable for operations (asked,
  auto-picked, suppressed, mapped, declined/abandoned, expired) without
  high-cardinality or content-bearing telemetry.
- **FR-013**: The Clarifier and pending-store contracts MUST be consumable by
  future detectors (e.g. routine step-input ambiguity) without modification —
  they carry no routine- or retrieval-specific fields. (The step-input detector
  itself is out of scope.)
- **FR-014**: When no candidate clears the minimum-confidence floor, the turn MUST
  behave exactly as it would today with no match (no clarification among uniformly
  weak candidates).

### Key Entities

- **Clarification candidate**: `{ id, label, description?, confidence, payload }` —
  payload opaque to the Clarifier, owned by the originating detector; confidence
  ordinal within its candidate set.
- **Closeness policy**: per-surface decision rule — closeness test between top
  candidates, minimum-confidence floor, presented-options cap.
- **Pending clarification**: conversation-scoped record — originating source,
  presented candidate set (with payloads), asked-turn reference, expiry; at most
  one per conversation; committed/cleared with the turn.
- **Clarification trace record**: per-turn record of candidates considered,
  closeness, decision (auto-pick / ask / suppressed, with reason incl. priority
  arbitration), and reply-mapping outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a test set of ambiguous activation messages against agents with
  overlapping routines, the assistant asks instead of starting a routine in 100% of
  too-close, priority-tied cases, and the visitor's choice starts the chosen
  routine — with its activation variables — in one additional turn.
- **SC-002**: On a corpus with two distinct senses of a term, ambiguous queries
  produce a clarifying question, and post-choice answers are grounded only in the
  chosen sense (verified via citations) — the documented wrong-sense answer no
  longer occurs in the test set.
- **SC-003**: Zero behavior change on clear-winner, unique-priority, and
  unambiguous cases: existing routine-activation and retrieval test suites pass
  unchanged, and no clarifying question appears in the unambiguous test set.
- **SC-004**: Routine activation makes no per-routine model calls and incurs no
  sequential per-routine model latency: one activation model call regardless of
  routine count, measured as one call for an agent with 10 published routines
  versus one call for an agent with 1.
- **SC-005**: Operators can see every clarification decision (asked, auto-picked,
  or suppressed; candidates; outcome) as a first-class node in the conversation
  debug turn-flow view, verified by frontend tests.
- **SC-006**: Clarifying questions and reply mapping work in non-English
  conversations (verified in at least two languages in tests).
- **SC-007**: A conversation never shows the same clarifying question twice in a
  row, and "none of these" always reaches a normal best-effort answer on the next
  turn.
- **SC-008**: A forced failure between question generation and turn commit leaves
  no pending clarification state (verified by a lifecycle test).

## Assumptions

- **Detector scope (approved)**: v1 ships the shared Clarifier + routine-activation
  detector + retrieval-sense detector. The routine step-input detector is deferred;
  only the generic contracts (FR-013) prepare for it.
- **Sense sourcing (approved)**: v1 derives senses by grouping the retrieved
  results; a settings-owned glossary is a possible later addition, not in scope.
- **Ask UX (approved)**: v1 asks via a plain LLM-phrased assistant message and maps
  free-text replies; structured option chips are a possible fast-follow.
- **Policy ownership (approved)**: per-surface system defaults only; no per-agent
  tuning surface in v1.
- **Active-routine behavior (decision)**: suppressed-ask mode while routine state
  is active, including yielded turns — clarification asks only when no routine is
  in flight. Revisited when the step-input detector is designed.
- Pending clarification expiry mirrors in-flight routine state lifetime
  conventions; exact duration is a planning detail.
- Issue #667's claim that 082 already returns ranked activation candidates is
  stale: the ranked matcher is built here (FR-007), fulfilling the seam obligation
  recorded in the 082 plan.

## Dependencies

- Conversation engine turn spine and trace envelope (082 and prior work) — present.
- Published routines with trigger descriptions, authored activation priority, and
  gate references (082) — present.
- Conversational retrieval pipeline with ranked results and document metadata —
  present.
- Deferred turn-commit discipline for conversation-scoped state (routine state
  command-capture) — present; pending clarification joins it.
- No dependency on 079 export/import or agent-config versioning.
