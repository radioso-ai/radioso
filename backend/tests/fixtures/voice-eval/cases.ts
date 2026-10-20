import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";

/**
 * The committed voice cases: bridge timing, the turn limit and the outcome derivation, run
 * through the real voice turn policy (`modules/voiceChannel/services/voiceTurnPolicy.ts`) rather
 * than a plain chat reply. The deterministic harness (`tests/unit/eval-suite/voice-behaviour.test.ts`)
 * runs a case with a `voiceTurn.chatEvents` script against a `VoiceTurnService` built with a tiny
 * timing override, and a case naming `voiceTurn.scriptedBrain` on a test composition's own chat
 * turn over that model in `scriptedBrains.ts`, on its generous timing. `scripts/runEvals.ts` runs
 * every case with an assertion a live turn can check against the real brain, ignores the scripts,
 * and seeds `routines.ts`'s `voiceEvalCallbackRoutine` so `voice-outcome-handoff` has a real
 * routine hand-off to reach. See `tests/fixtures/conversation-quality/README.md`'s "Voice cases"
 * section.
 */
export const voiceEvalCases: ConversationQualityCase[] = [
  {
    id: "voice-bridge-on-searching",
    name: "Bridges while the turn searches",
    tags: ["voice"],
    query: "Can you check what the cancellation policy says about partial refunds?",
    // The deterministic half runs this on a test composition's own retrieval (scriptedBrains.ts).
    voiceTurn: { scriptedBrain: "searching-then-answer" },
    assertions: [
      { type: "voice_bridge_emitted", expected: true },
      { type: "voice_turn_outcome", kind: "continue" },
    ],
  },
  {
    id: "voice-quick-reply-no-bridge",
    name: "Answers a thank-you with no bridge",
    tags: ["voice"],
    query: "Great, thanks so much for your help!",
    voiceTurn: {
      // The deterministic half runs this on a test composition's own planner and quick-reply lane
      // (scriptedBrains.ts), with a composer slow enough that a thank-you it answered would bridge.
      scriptedBrain: "thanks-quick-reply",
    },
    assertions: [
      // Deterministic-only by definition: live, "no bridge" holds only while the planner beats
      // the 2.5 s stall bridge.
      { type: "voice_bridge_emitted", expected: false },
      // Beside the bridge it is out of scope live, `continue` alone is any answer's outcome, so
      // the case runs in the deterministic half only.
      { type: "voice_turn_outcome", kind: "continue", deterministicOnly: true },
    ],
  },
  {
    id: "voice-turn-limit-fires",
    name: "Falls back once the turn limit passes with nothing said",
    tags: ["voice"],
    query: "What's the status of the order I placed last week?",
    voiceTurn: {
      // Never advances past "interpreting" and never answers, so only the turn's own limit
      // (not a scripted delay) decides when the fallback line ends the turn.
      chatEvents: [
        { type: "status", stage: "interpreting" },
        { type: "stall" },
      ],
    },
    assertions: [
      // Deterministic-only by definition: no live question stalls the planner for 10 s.
      { type: "voice_turn_limit_reached", expected: true },
      // `continue` after the fallback line is what this case checks; without the limit, it is
      // any answer's outcome, so the case runs in the deterministic half only.
      { type: "voice_turn_outcome", kind: "continue", deterministicOnly: true },
    ],
  },
  {
    id: "voice-outcome-handoff",
    name: "Reports a callback outcome once a hand-off collects a slot",
    tags: ["voice"],
    // States the hand-off and the slot the live run's seeded voiceEvalCallbackRoutine collects
    // (routines.ts) in one message, so the routine reaches its `handoff` terminal with
    // `callbackNumber` filled on this turn alone, not a second one — see routines.ts for why a
    // routine is the only way to produce `callback_requested` at all. Names no topic the seeded
    // corpus (conversation-quality/corpus.ts, seeded onto the same agent regardless of --tag)
    // covers: an earlier wording that mentioned "my refund" pulled the live planner toward a
    // retrieval answer about the refund policy document instead of the callback routine on some
    // samples.
    query: "Can someone call me back today? My number is 555-0199.",
    voiceTurn: {
      chatEvents: [
        { type: "status", stage: "interpreting" },
        { type: "chunk", text: "Let me get a teammate to call you back about that." },
        { type: "done", handoff: { reason: "routine_handoff", collectedSlotCount: 1 } },
      ],
    },
    assertions: [
      { type: "voice_turn_outcome", kind: "callback_requested" },
    ],
  },
];
