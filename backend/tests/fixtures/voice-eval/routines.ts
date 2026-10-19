import type { RoutineDefinition } from "../../../src/modules/routines/public.js";

const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

const defaultTransition = (fromStep: string, toRef: string, ordinal: number) => ({
  fromStep,
  toRef,
  guardKind: "default" as const,
  guardText: null,
  outcomeStatus: null,
  counterLimit: null,
  fieldRef: null,
  fieldOp: null,
  fieldValue: null,
  fieldValues: null,
  fieldUnit: null,
  ordinal,
});

export const VOICE_EVAL_CALLBACK_ROUTINE_ID = "routine:voice-eval-agent:callback-handoff:v1";

/**
 * One slot, one chat step, straight to a `handoff` terminal: the smallest routine that can show
 * `voice-outcome-handoff` a real `callback_requested` outcome. `deriveVoiceTurnOutcome` reports
 * that outcome only for a routine hand-off that collected at least one declared slot — never for
 * a retrieval-miss hand-off, which always collects zero — so a routine with a filled slot is the
 * only way to produce it live; none of the text suite's seeded routines (`routines.ts` in
 * `conversation-quality/`) ends on a `handoff` terminal, so this is a new one, not a reused one.
 * The compiler auto-promotes `ask_callback_number`'s single `default` exit to run the selector
 * (the same promotion `conversation-quality/routines.ts`'s `defaultTransition`-based steps get),
 * which can fill the slot straight from the activating message — so a caller who states the
 * number while asking for a callback reaches the hand-off terminal in that same turn, with no
 * second turn needed. Seeded only while a voice case runs (`runEvals.ts`'s `runsVoiceCases`), so
 * a text-suite run never carries a second "ask a human to follow up" trigger alongside
 * `contactSupportRoutine`'s.
 */
export const voiceEvalCallbackRoutine: RoutineDefinition = {
  id: VOICE_EVAL_CALLBACK_ROUTINE_ID,
  agentId: "voice-eval-agent",
  lineageId: "lineage:voice-eval-callback-handoff",
  version: 1,
  enabled: true,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
  name: "Voice callback",
  activation: {
    triggerDescription: "the user asks for a callback and states a phone number to reach them on",
    gateRef: null,
    priority: 10,
    reentryMode: "once_per_conversation",
  },
  slots: [
    {
      stableSlotId: "slot_callback_number",
      key: "callbackNumber",
      type: "text",
      required: true,
      description: "The phone number to call them back on.",
      ordinal: 0,
    },
  ],
  steps: [
    {
      stableStepId: "ask_callback_number",
      kind: "chat",
      instruction: "Ask for the phone number to call them back on: {{slot.callbackNumber}}",
      toolRef: null,
      actionType: null,
      ordinal: 0,
      metadata: {},
    },
  ],
  transitions: [
    defaultTransition("ask_callback_number", "handoff", 0),
  ],
  terminals: [
    { stableStepId: "handoff", kind: "handoff", instruction: "Confirm someone will call them back on that number soon.", ordinal: 0 },
  ],
};

export const voiceEvalRoutines: RoutineDefinition[] = [voiceEvalCallbackRoutine];
