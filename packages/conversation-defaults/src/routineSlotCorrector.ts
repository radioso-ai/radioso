import type {
  ConversationMessage,
  ConversationModelGateway,
  ConversationRoutineSlotCorrection,
  Routine,
  RoutineSlotCorrectionDetection,
  RoutineSlotCorrectionSkipReason,
  RoutineSlotSchema,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";
import { redactSensitiveValues } from "@radioso/conversation-contract";
import { completedRunSentValues, correctableSlots } from "@radioso/conversation-engine";

import {
  DEFAULT_ROUTINE_SLOT_CORRECTION_CONFIRM_PROMPT,
  DEFAULT_ROUTINE_SLOT_CORRECTION_DETECT_PROMPT,
  DEFAULT_ROUTINE_SLOT_CORRECTION_INVALID_PROMPT,
} from "./generated/defaultPrompts.js";
import { localIsoDate, turnTimeZone } from "./localDate.js";
import { renderPromptTemplate } from "./promptTemplate.js";

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const none = (reason: RoutineSlotCorrectionSkipReason): RoutineSlotCorrectionDetection => ({ kind: "none", reason });

const heldValueText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));

// What the run holds goes in beside each slot: given only keys and types, the model could not
// tell "I'd like to book from 8 to 10 January" from a change to an arrival the run never held
// (#1714). A sensitive slot's value reads masked, as in every copy the runner hands out.
const heldSlotsBlock = (slots: readonly RoutineSlotSchema[], held: Record<string, unknown>): string =>
  slots
    .map((slot) => [
      `- key: ${slot.key}`,
      `  type: ${slot.type}`,
      ...(slot.description ? [`  description: ${slot.description}`] : []),
      `  holds: ${heldValueText(held[slot.key])}`,
    ].join("\n"))
    .join("\n");

interface DetectedCorrection {
  slotKey: string;
  value: string;
}

/** The model's decision: a correction to an offered slot, a new request, or null for anything else. */
const parseDetection = (raw: string, offeredKeys: ReadonlySet<string>): DetectedCorrection | "new_request" | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.intent === "new_request") {
    return "new_request";
  }
  const { slotKey, value } = parsed;
  if (parsed.intent !== "correction" || typeof slotKey !== "string" || !offeredKeys.has(slotKey)) {
    return null;
  }
  // The model normalizes to the field type; accept string/number/boolean and stringify
  // so the engine's deterministic verifier re-parses against the declared type.
  if (typeof value === "string") {
    return value.trim().length > 0 ? { slotKey, value } : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return { slotKey, value: String(value) };
  }
  return null;
};

/**
 * Host implementation of {@link ConversationRoutineSlotCorrection}. It owns routine
 * resolution (from the per-turn routine set) and the model-driven, multilingual detection
 * and confirmation copy. It deliberately does NOT decide validity — the engine re-checks
 * with `verifySlotCorrection`. It offers a correction only to an editable slot the completed
 * run holds, and only while nothing the run held has left the conversation: once an ending
 * notified someone, or a tool, action, or approval step ran, a corrected value would reach
 * none of them (#1714). Each of those checks short-circuits without a model call, so the
 * common post-completion turn stays cheap.
 */
export class RoutineSlotCorrector implements ConversationRoutineSlotCorrection {
  private readonly routinesById: Map<string, Routine>;
  private readonly detectPrompt: string;
  private readonly confirmPrompt: string;
  private readonly invalidPrompt: string;
  private readonly clock: () => Date;

  constructor(
    routines: readonly Routine[],
    private readonly modelGateway: ConversationModelGateway,
    options: {
      detectPromptTemplate?: string;
      confirmPromptTemplate?: string;
      invalidPromptTemplate?: string;
      /** Dates the turn, so a date given without a year resolves; defaults to the wall clock. */
      clock?: () => Date;
    } = {},
  ) {
    this.routinesById = new Map(routines.map((routine) => [routine.id, routine]));
    this.detectPrompt = options.detectPromptTemplate ?? DEFAULT_ROUTINE_SLOT_CORRECTION_DETECT_PROMPT;
    this.confirmPrompt = options.confirmPromptTemplate ?? DEFAULT_ROUTINE_SLOT_CORRECTION_CONFIRM_PROMPT;
    this.invalidPrompt = options.invalidPromptTemplate ?? DEFAULT_ROUTINE_SLOT_CORRECTION_INVALID_PROMPT;
    this.clock = options.clock ?? (() => new Date());
  }

  async detect(input: { turn: TurnContext; completedState: RoutineState }): Promise<RoutineSlotCorrectionDetection> {
    const { completedState, turn } = input;
    const routine = this.routinesById.get(completedState.routineId);
    if (!routine) {
      return none("unknown_routine");
    }
    const slots = routine.slots ?? [];
    if (!slots.some((slot) => slot.mutable)) {
      return none("no_mutable_slot");
    }
    const heldSlots = correctableSlots(slots, completedState.variables, routine.consents);
    if (heldSlots.length === 0) {
      return none("not_held");
    }
    if (completedRunSentValues(routine, completedState)) {
      return none("already_sent");
    }
    const held = redactSensitiveValues(
      completedState.variables,
      slots.filter((slot) => slot.sensitivity === "sensitive").map((slot) => slot.key),
    );
    const today = localIsoDate(this.clock(), turnTimeZone(turn));
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(turn),
      systemPrompt: renderPromptTemplate("chat/routine-slot-correction-detect.md", this.detectPrompt, {
        slots: heldSlotsBlock(heldSlots, held),
        today: today.isoDate,
        time_zone: today.timeZone,
      }),
      metadata: {
        routineSlotCorrectionDetect: true,
        agentId: turn.agent.id,
      },
    });
    const detected = parseDetection(text, new Set(heldSlots.map((slot) => slot.key)));
    if (detected === "new_request") {
      return none("new_request");
    }
    if (!detected) {
      return none("not_a_correction");
    }
    // Pass the full declared slot schema so the engine verifies against the real type +
    // mutability, not just the subset shown to the model.
    return { kind: "correction", slots, slotKey: detected.slotKey, rawValue: detected.value };
  }

  async rejectInvalid(input: { turn: TurnContext; routineId: string; slotKey: string }): Promise<string> {
    const routine = this.routinesById.get(input.routineId);
    const slotType = (routine?.slots ?? []).find((slot) => slot.key === input.slotKey)?.type ?? "text";
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt: renderPromptTemplate("chat/routine-slot-correction-invalid.md", this.invalidPrompt, {
        slotKey: input.slotKey,
        slotType,
      }),
      metadata: {
        routineSlotCorrectionInvalid: true,
        agentId: input.turn.agent.id,
      },
    });
    return text.trim();
  }

  async confirm(input: {
    turn: TurnContext;
    routineId: string;
    slotKey: string;
    value: string | number | boolean;
  }): Promise<string> {
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt: renderPromptTemplate("chat/routine-slot-correction-confirm.md", this.confirmPrompt, {
        slotKey: input.slotKey,
        value: String(input.value),
      }),
      metadata: {
        routineSlotCorrectionConfirm: true,
        agentId: input.turn.agent.id,
      },
    });
    return text.trim();
  }
}
