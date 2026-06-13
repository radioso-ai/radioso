# Quickstart: Clarification Capability (085)

How to exercise and validate the feature locally.

## Prerequisites

```bash
./run-dev.sh          # full local stack (Postgres + backend + worker + frontend)
```

Migrations run on backend start; verify `clarification_states` exists:
`\d clarification_states` in psql.

## US1 — Routine activation clarification

1. In the dashboard, on one agent, author and **publish two routines** with
   overlapping triggers, e.g. trigger descriptions "user wants to book a product
   demo" and "user wants to book a support call", same priority.
2. Open the agent's chat (or embed preview) and send an ambiguous message:
   *"I'd like to book a call"*.
   - Expect: one clarifying question naming both options; no routine starts.
3. Reply *"the demo one"* (or in another language).
   - Expect: the demo routine starts at its first step.
4. Send a clearly-targeted message in a fresh conversation: *"I need a support
   call about my error"*.
   - Expect: support routine starts immediately, no question.
5. Repeat step 2, but reply *"neither, what are your opening hours?"*.
   - Expect: no routine; normal grounded answer; no re-ask.
6. Set one routine's activation priority higher and repeat step 2.
   - Expect: silent activation of the higher-priority routine (trace shows
     "priority arbitration").

## US2 — Retrieval sense clarification

1. Ingest two document sets with one shared term and two distinct senses (the
   fixture set under `backend/tests/fixtures/` — hatha-yoga vs raja-yoga docs).
2. Ask: *"tell me about yoga"*.
   - Expect: immediate grounded answer scoped to the strongest sense, plus a
     brief inline offer of the alternative sense(s). Trace shows `offered`.
3. Pick the offered alternative on the next turn.
   - Expect: answer cites only the chosen alternative sense's documents and
     answers the original question, not just the selector reply.
4. Ignore the offer with an unrelated next turn.
   - Expect: normal handling of the new message, no decline message, and no
     repeated offer of the same sense set.
5. Ask an unambiguous question: *"what is hatha yoga?"*.
   - Expect: immediate answer, no question.
6. Activate a routine, then mid-routine ask the ambiguous question.
   - Expect: no clarifying question (suppressed-ask); best-effort answer; trace
     records the suppression.

## US3 — Operator trace

1. Open Dashboard → conversation history → the conversations from above →
   debug/turn-flow view.
2. Expect a **Clarification** node on asked, auto-picked, and suppressed turns;
   detail panel shows candidates (labels + confidence), decision, reason, and
   the reply-mapping outcome on resolving turns. No document content anywhere.

## Automated validation

```bash
# Packages (pure decide, ranked matcher, clarifier ports)
cd packages/conversation-engine && pnpm test
cd packages/conversation-defaults && pnpm test

# Backend (TDD slices: store/lifecycle commit, matcher wiring, sense grouping,
# resolver orchestration, counters)
cd backend && pnpm run test:unit && pnpm run test:integration

# Frontend (turn-flow/turn-trace transforms + trace-view journey)
cd frontend && pnpm test && pnpm run test:e2e

# Full local CI before PR
pnpm run ci:local -- origin/main
```

## Counters

`curl localhost:8080/metrics | grep clarification_decisions_total` — labels
`surface` (routine_activation | retrieval_sense) × `decision`
(asked | offered | auto_picked | suppressed | mapped |
offer_accepted_alternative | offer_ignored | declined | expired).
