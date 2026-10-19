import type { AgentVoiceSettings } from "../../../src/modules/agents/public.js";
import type { ConversationQualityCase } from "../../../src/modules/eval/suite/index.js";
import type { RoutineDefinitionDraftInput } from "../../../src/modules/routines/public.js";

/**
 * The voice cases: whole voice turns through the `generic` dialect of the completions door, one
 * streamed request per caller turn, scored on what the runtime received. Every case runs in the
 * deterministic half (tests/unit/eval-suite/voice-cases.test.ts) against the test app with a
 * scripted brain; the live half (`pnpm run evals:voice`) runs those that do not need a scripted
 * brain's timing against the real model, and gates on the wire alone.
 */

/** The voice block the voice cases' agent carries; the runner tells bridge and fallback lines apart by it. */
export const conversationQualityVoiceSettings = {
  enabled: true,
  bridgeLines: {
    en: {
      acknowledge: ["Got it, thank you, give me a moment to note that down."],
      check: ["Let me check that for you, it only takes a moment."],
    },
  },
  fallbackLine: { en: "Sorry, this is taking much longer than it should, could you ask me that again?" },
} satisfies Pick<AgentVoiceSettings, "enabled" | "bridgeLines" | "fallbackLine">;

/** The language every voice case's session starts in, as the page that starts the call sends it. */
const SESSION_LOCALE = "en";

/** What the teammate writes from the Inbox in the teammate-reply case, spoken before the agent's answer. */
const VOICE_TEAMMATE_REPLY = "Four works for us.";

/** The routine the callback case completes: one slot, asked for once, ending in a hand-off to a person. */
export const voiceCallbackRoutineDraft: RoutineDefinitionDraftInput = {
  name: "Request a callback",
  enabled: true,
  activation: {
    triggerDescription: "the caller asks for someone from the team to call them back",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [{
    stableSlotId: "slot_phone",
    key: "phone",
    type: "text",
    required: true,
    description: "The phone number to call the caller back on.",
    ordinal: 0,
  }],
  steps: [{
    stableStepId: "ask_phone",
    kind: "chat",
    instruction: "Ask what number we should call them back on: {{slot.phone}}",
    toolRef: null,
    ordinal: 0,
    metadata: {},
  }],
  transitions: [{
    fromStep: "ask_phone",
    toRef: "callback_handoff",
    guardKind: "llm",
    guardText: "The caller gave a phone number to call back: {{slot.phone}}.",
    ordinal: 0,
  }],
  terminals: [{
    stableStepId: "callback_handoff",
    kind: "handoff",
    instruction: "Tell them a teammate will ring them on {{slot.phone}} shortly.",
    ordinal: 1,
  }],
};

export const conversationQualityVoiceCases: ConversationQualityCase[] = [
  {
    id: "voice-knowledge-bridge-on-search",
    name: "Voice: a knowledge question bridges as the turn starts searching",
    description: "A retrieval turn always has seconds of work ahead, so the bridge line is spoken the moment the turn starts searching, then the answer.",
    tags: ["voice"],
    voice: { locale: SESSION_LOCALE },
    query: "How long do I have to ask for a refund?",
    assertions: [
      { type: "voice_turn_well_formed" },
      { type: "voice_bridge_spoken", spoken: true },
      { type: "voice_speech_order", order: ["bridge", "speech"] },
      { type: "voice_outcome", kind: "continue" },
      { type: "voice_turn_log", fields: { bridged: true, turnLimitReached: false, languageSource: "session", outcome: "continue" } },
    ],
  },
  {
    id: "voice-greeting-quick-reply-no-bridge",
    name: "Voice: a greeting is answered by the quick-reply lane with no bridge",
    description: "The planner writes a greeting's reply itself, well inside the composing idle, so no bridge line comes before it.",
    tags: ["voice", "quick-reply"],
    voice: { locale: SESSION_LOCALE },
    query: "Hi there!",
    assertions: [
      { type: "voice_turn_well_formed" },
      { type: "voice_bridge_spoken", spoken: false },
      { type: "voice_speech_order", order: ["speech"] },
      { type: "voice_speech_piece_count", count: 1 },
      { type: "voice_outcome", kind: "continue" },
      { type: "voice_turn_log", fields: { bridged: false, turnLimitReached: false, languageSource: "session", outcome: "continue" } },
    ],
  },
  {
    id: "voice-slow-composer-bridges-after-idle",
    name: "Voice: a composer that stays silent past the idle gets the bridge, then its answer",
    description: "A direct answer whose composer says nothing for longer than the composing idle hears the bridge line, then the answer; no turn limit.",
    tags: ["voice"],
    voice: { locale: SESSION_LOCALE, requiresScriptedTiming: true },
    query: "What should I bring to my first appointment?",
    assertions: [
      { type: "voice_turn_well_formed" },
      { type: "voice_bridge_spoken", spoken: true },
      { type: "voice_speech_order", order: ["bridge", "speech"] },
      { type: "voice_outcome", kind: "continue" },
      { type: "voice_turn_log", fields: { bridged: true, turnLimitReached: false, outcome: "continue" } },
    ],
  },
  {
    id: "voice-stalled-reply-turn-limit",
    name: "Voice: a reply stalled past the turn limit ends with the fallback line",
    description: "Nothing comes from the composer for longer than the turn limit, so after the bridge the caller hears the agent's fallback line and the call goes on.",
    tags: ["voice"],
    voice: { locale: SESSION_LOCALE, requiresScriptedTiming: true },
    query: "Can you walk me through every plan you offer?",
    assertions: [
      { type: "voice_turn_well_formed" },
      { type: "voice_speech_order", order: ["bridge", "fallback"] },
      { type: "voice_outcome", kind: "continue" },
      { type: "voice_turn_log", fields: { bridged: true, turnLimitReached: true, fallbackSpoken: true, outcome: "continue" } },
    ],
  },
  {
    id: "voice-callback-routine-requests-callback",
    name: "Voice: a callback routine that captures a number ends the call with callback_requested",
    description: "The callback routine asks for a number, the caller gives one, and the routine hands off holding it, so the runtime is told the caller asked to be called back.",
    tags: ["voice", "routine"],
    voice: {
      locale: SESSION_LOCALE,
      before: [{ kind: "caller", utterance: "Could someone from your team call me back about my order?" }],
    },
    query: "Sure, my number is 020 7946 0123.",
    assertions: [
      { type: "voice_turn_well_formed" },
      { type: "voice_outcome", kind: "callback_requested" },
      { type: "voice_turn_log", fields: { outcome: "callback_requested", handoffReason: "routine_handoff" } },
    ],
  },
  {
    id: "voice-human-owned-waiting-line",
    name: "Voice: a call a teammate took over hears the waiting line, with no bridge and no limit",
    description: "A person owns the conversation, so chat answers with its waiting line; no bridge line comes before it and no fallback line talks over it, however long it takes.",
    tags: ["voice", "handoff"],
    voice: {
      locale: SESSION_LOCALE,
      before: [{ kind: "caller", utterance: "When are you open on Saturdays?" }, { kind: "teammate_takes_over" }],
    },
    query: "Hello, is someone there?",
    assertions: [
      { type: "voice_turn_well_formed" },
      { type: "voice_bridge_spoken", spoken: false },
      { type: "voice_speech_order", order: ["speech"] },
      { type: "voice_outcome", kind: "continue" },
      { type: "voice_turn_log", fields: { bridged: false, turnLimitReached: false, languageSource: null, outcome: "continue" } },
    ],
  },
  {
    id: "voice-teammate-reply-spoken-first",
    name: "Voice: a teammate's pending reply is spoken first, and no bridge follows it",
    description: "A teammate replied from the Inbox and handed the call back; the caller's next turn hears that reply before the agent's answer, and the knowledge question that would bridge does not.",
    tags: ["voice", "handoff"],
    voice: {
      locale: SESSION_LOCALE,
      before: [
        { kind: "caller", utterance: "Can I come in at four tomorrow?" },
        { kind: "teammate_replies", text: VOICE_TEAMMATE_REPLY },
        { kind: "teammate_hands_back" },
      ],
    },
    query: "Great. And how long do I have to ask for a refund?",
    assertions: [
      { type: "voice_turn_well_formed" },
      { type: "voice_bridge_spoken", spoken: false },
      { type: "voice_first_speech", text: VOICE_TEAMMATE_REPLY },
      { type: "voice_speech_order", order: ["speech"] },
      { type: "voice_outcome", kind: "continue" },
      { type: "voice_turn_log", fields: { bridged: false, spokenOperatorReplies: 1, outcome: "continue" } },
    ],
  },
];
