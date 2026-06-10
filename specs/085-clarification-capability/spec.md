# Feature Specification: Clarification Capability

**Feature Branch**: `085-clarification-capability`
**Created**: 2026-06-10
**Status**: Draft
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
grows with each published routine. Building the ranked matcher is in scope here.)

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
   directly.
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
   **Then** activation is decided in a single evaluation over all candidates (turn
   latency does not grow per published routine the way today's one-by-one checks do).

---

### User Story 2 - Retrieval sense clarification (Priority: P2)

A workspace corpus covers two distinct senses of the same term (the canonical
example: *hatha yoga* and *raja yoga* documents). A visitor asks "tell me about
yoga". Instead of picking one sense and grounding the answer in it — sometimes
wrongly — the assistant notices the corpus offers clearly distinct senses, asks which
one the visitor means, and then answers grounded in the chosen sense. Queries whose
results are not meaningfully split answer immediately, exactly as today.

Sense candidates come **from the retrieved data** (the top results separating into
distinct groups), never from an authored or hard-coded term list.

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

---

### User Story 3 - Operator explainability (Priority: P3)

An operator reviewing a conversation in the debug/workbench view can see every
clarification decision: which candidates were considered, how close they were,
whether the system auto-picked silently or asked, and which candidate the visitor's
reply mapped to. Silent auto-picks on close-but-decidable calls are visible too, so
operators can judge whether the system asks too often or guesses too much.

**Why this priority**: Explainability is the operational half of the feature —
without it, operators cannot tune content/routines or trust the new behavior — but
it is consumed by operators, not end users, and depends on US1/US2 existing.

**Independent Test**: Drive an ambiguous and an unambiguous conversation turn, open
the conversation's debug trace as an operator, and verify both decisions are visible
with candidates and outcome.

**Acceptance Scenarios**:

1. **Given** a turn where clarification was asked, **When** an operator opens the
   conversation trace, **Then** they see the candidate set (labels and closeness),
   the decision "asked", and — after the visitor replies — which candidate was chosen
   (or that the visitor declined all).
2. **Given** a turn where a clear winner was auto-picked, **When** an operator opens
   the trace, **Then** they see the candidates and that the top one was auto-picked
   without asking.
3. **Given** any clarification trace content, **Then** it contains candidate labels
   and decision data only — no raw document content, prompts, or credentials.

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
- **Clarification while a routine is active**: out of scope for this feature (the
  step-input detector is deferred); an active routine's turns are never interrupted
  by activation or sense clarification.
- **Channel coverage**: works on every conversational surface (dashboard chat,
  website embed, assistant API channels) because the question is an ordinary
  assistant message and the reply is ordinary visitor text. Non-conversational
  surfaces (standalone retrieval answers, document search) never clarify.
- **Multilingual**: question phrasing and reply mapping must work in the
  conversation's language; reply mapping must accept free-text answers ("the second
  one", "hatha", "не то и не другое"), not just option labels.

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
  tests MUST stay focused on non-visual logic.
- Secrets and keys MUST live in `.env`; `.env.example` updated if new configuration
  is introduced.
- Modular boundaries between transport, orchestration, domain logic, and persistence
  MUST be preserved (see Architecture Constraints).
- Message-queue impact review: this feature changes no worker payloads, queue
  contracts, or document-worker dispatch. Pending-clarification state is
  conversation-scoped request-path state, like in-flight routine state. If planning
  discovers any queue contact, the plan must revisit this review.
- Observability: clarification decisions are a new runtime path and MUST be traced
  (US3) and countable (asked vs auto-picked vs mapped/declined) without recording
  raw prompts, completions, or document content.

## Architecture Constraints *(mandatory)*

- **Boundary Rule — Clarifier is generic and primary**: the Clarifier (decide
  auto-pick vs ask; produce the question; map the reply; manage pending state) is a
  turn-level capability of the conversation engine layer. It knows nothing about
  routines or retrieval — it consumes only a ranked candidate set
  (id, label, description, confidence) plus a closeness policy. It MUST be reachable
  from a normal answer turn, because the retrieval case fires with no routine
  active. Clarification is **not** modeled as a routine.
- **Boundary Rule — Detectors are surface-owned**: each detector lives with its
  surface and depends only on the narrow Clarifier port: routine-activation
  detection in the routine activation path; sense detection inside the retrieval
  module's query-interpretation/answer pipeline. Neither detector's vocabulary leaks
  into the Clarifier.
- **Encapsulation Rule**: the chat orchestration service remains orchestration-only —
  it may route a turn into/out of clarification but MUST NOT contain candidate
  scoring, question phrasing, reply mapping, or policy thresholds. Retrieval's
  query-rewrite service remains a query-interpretation concern and MUST NOT own
  pending-clarification state.
- **New Seams Required**:
  - A Clarifier port + default implementation in the conversation engine layer
    (contract + engine packages), with pending-clarification conversation state
    modeled like in-flight routine state.
  - A ranked multi-routine activation matcher: one evaluation across all registered
    routine triggers returning ranked candidates with confidences, replacing the
    sequential per-routine yes/no short-circuit (this fulfils the 082 plan's
    recorded seam obligation).
  - A sense-grouping detector seam in retrieval interpretation that derives sense
    candidates from the retrieved set and can constrain a follow-up retrieval to a
    chosen sense.
  - A clarification trace stage on the turn trace spine (additive).
- **Anti-Goals**:
  - Do not build clarification as a routine or inside the routine runner.
  - Do not add per-agent settings UI, authoring surfaces, or a term/sense glossary
    in this feature; closeness policy ships as per-surface system defaults.
  - Do not introduce structured option chips / quick-reply UI in this feature; the
    question is a plain assistant message (chips are a candidate fast-follow).
  - Do not encode senses, trigger phrases, or option-matching vocabulary in code.
  - Do not let the engine package gain knowledge of retrieval, or the retrieval
    module gain knowledge of routines.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a single generic clarification mechanism that
  accepts a ranked candidate set — each candidate having an identifier, a short
  human-readable label, an optional description, and a confidence — plus a closeness
  policy, and decides: auto-pick the top candidate (clear winner) or ask the user
  (too close).
- **FR-002**: Closeness policies MUST be defined per consuming surface (routine
  activation; retrieval sense) as system defaults, including a top-vs-runner-up
  closeness test, a minimum-confidence floor below which candidates are ignored,
  and a cap (default 4) on options presented. No operator-facing tuning UI ships in
  this feature.
- **FR-003**: When clarification is asked, the question MUST be generated by the
  LLM from the candidate labels/descriptions in the conversation's language, as an
  ordinary assistant message, and the turn MUST NOT execute the guessed candidate.
- **FR-004**: The system MUST persist a pending clarification (the candidate set and
  its originating surface) scoped to the conversation, with a bounded lifetime
  consistent with in-flight routine state, surviving across turns until resolved,
  expired, or abandoned.
- **FR-005**: On the next visitor message while a clarification is pending, the
  system MUST interpret the reply (LLM-based, free text, multilingual) into exactly
  one of: a chosen candidate; an explicit "none of these"; or an unrelated message.
  Chosen → resume the originating flow with that candidate. None / unrelated →
  clear the pending state and handle the message as a normal turn.
- **FR-006**: The system MUST never ask the same clarifying question twice
  consecutively in a conversation (loop guard); after one failed mapping or a
  decline, it proceeds best-effort.
- **FR-007**: Routine activation MUST evaluate all of an agent's registered routine
  triggers in a single ranked evaluation producing per-routine confidences, instead
  of per-routine sequential yes/no checks, and MUST feed the ranked result through
  the clarification mechanism: clear winner → activate silently (today's outcome);
  too close → ask (US1); chosen candidate → activate that routine at its first step
  with normal behavior, including any activation-time variables.
- **FR-008**: During conversational retrieval, the system MUST detect when the
  retrieved material for a query separates into two or more clearly distinct sense
  groups, derive candidate senses from that data (label + description per sense),
  and feed them through the clarification mechanism; on a chosen sense, the answer
  MUST be grounded in the chosen sense's material. Sense derivation MUST come from
  the data (e.g. grouping of top results), never from authored or hard-coded term
  lists.
- **FR-009**: Clarification MUST operate only on conversational surfaces (dashboard
  chat, website embed, assistant API channels). Non-conversational surfaces —
  standalone retrieval answers, document search, MCP retrieval tools — are
  unchanged.
- **FR-010**: Every clarification decision (auto-pick or ask, with candidates and
  closeness; and the later reply mapping outcome) MUST appear as a distinct stage in
  the conversation turn trace visible to operators (US3), excluding raw document
  content and prompts.
- **FR-011**: Clarification activity MUST be countable for operations (asked,
  auto-picked, mapped, declined/abandoned, expired) without high-cardinality or
  content-bearing telemetry.
- **FR-012**: The clarification mechanism MUST be consumable by future detectors
  (e.g. routine step-input ambiguity) without modification — its contract carries no
  routine- or retrieval-specific fields. (The step-input detector itself is out of
  scope.)
- **FR-013**: When no candidate clears the minimum-confidence floor, the turn MUST
  behave exactly as it would today with no match (no clarification among uniformly
  weak candidates).

### Key Entities

- **Clarification candidate**: one option the system could act on — identifier,
  human-readable label, optional description, confidence, owning surface's
  reference (opaque to the Clarifier).
- **Closeness policy**: per-surface decision rule — closeness test between top
  candidates, minimum-confidence floor, presented-options cap.
- **Pending clarification**: conversation-scoped state holding the asked candidate
  set, originating surface, and expiry; at most one pending clarification per
  conversation.
- **Clarification trace record**: per-turn record of candidates considered,
  closeness, decision (auto-pick/ask), and reply-mapping outcome.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a test set of ambiguous activation messages against agents with
  overlapping routines, the assistant asks instead of starting a routine in 100% of
  too-close cases, and the visitor's choice starts the chosen routine in one
  additional turn.
- **SC-002**: On a corpus with two distinct senses of a term, ambiguous queries
  produce a clarifying question, and post-choice answers are grounded only in the
  chosen sense (verified via citations) — the documented wrong-sense answer no
  longer occurs in the test set.
- **SC-003**: Zero behavior change on clear-winner and unambiguous cases: existing
  routine-activation and retrieval test suites pass unchanged, and no clarifying
  question appears in the unambiguous test set.
- **SC-004**: A conversation turn's activation cost no longer grows with each
  published routine (single ranked evaluation), measured on an agent with 10
  published routines versus 1.
- **SC-005**: Operators can see every clarification decision (asked or auto-picked,
  candidates, outcome) for any conversation in the debug view.
- **SC-006**: Clarifying questions and reply mapping work in non-English
  conversations (verified in at least two languages in tests).
- **SC-007**: A conversation never shows the same clarifying question twice in a
  row, and "none of these" always reaches a normal best-effort answer on the next
  turn.

## Assumptions

- **Detector scope (approved)**: v1 ships the shared Clarifier + routine-activation
  detector + retrieval-sense detector. The routine step-input detector is deferred;
  only the generic contract (FR-012) prepares for it.
- **Sense sourcing (approved)**: v1 derives senses by grouping the retrieved
  results; a settings-owned glossary is a possible later addition, not in scope.
- **Ask UX (approved)**: v1 asks via a plain LLM-phrased assistant message and maps
  free-text replies; structured option chips are a possible fast-follow.
- **Policy ownership (approved)**: per-surface system defaults only; no per-agent
  tuning surface in v1.
- Pending clarification expiry mirrors in-flight routine state lifetime
  conventions; exact duration is a planning detail.
- The trace/debug view already renders the turn trace spine; US3 needs the new
  stage rendered legibly there, not a new operator surface.
- Issue #667's claim that 082 already returns ranked activation candidates is
  stale: the ranked matcher is built here (FR-007), fulfilling the seam obligation
  recorded in the 082 plan.

## Dependencies

- Conversation engine turn spine and trace envelope (082 and prior work) — present.
- Published routines with trigger descriptions (082) — present.
- Conversational retrieval interpretation pipeline — present.
- No dependency on 079 export/import or agent-config versioning.
