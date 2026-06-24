import type {
  ConversationMessage,
  ConversationModelGateway,
  ConversationRoutineSlotCorrection,
  Routine,
  RoutineSlotCorrectionCandidate,
  RoutineSlotSchema,
  RoutineState,
  TurnContext,
} from "@radioso/conversation-contract";

import {
  DEFAULT_ROUTINE_SLOT_CORRECTION_CONFIRM_PROMPT,
  DEFAULT_ROUTINE_SLOT_CORRECTION_DETECT_PROMPT,
  DEFAULT_ROUTINE_SLOT_CORRECTION_INVALID_PROMPT,
} from "./generated/defaultPrompts.js";
import { renderPromptTemplate } from "./promptTemplate.js";

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const slotsBlock = (slots: readonly RoutineSlotSchema[]): string =>
  slots
    .map((slot) => `- key: ${slot.key}\n  type: ${slot.type}${slot.description ? `\n  description: ${slot.description}` : ""}`)
    .join("\n");

interface DetectedCorrection {
  slotKey: string;
  value: string;
}

const parseDetection = (raw: string, mutableKeys: ReadonlySet<string>): DetectedCorrection | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    const slotKey = parsed.slotKey;
    const value = parsed.value;
    if (typeof slotKey !== "string" || !mutableKeys.has(slotKey)) {
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
  } catch {
    return null;
  }
};

/**
 * Host implementation of {@link ConversationRoutineSlotCorrection}. It owns routine
 * resolution (from the per-turn routine set) and the model-driven, multilingual detection
 * and confirmation copy. It deliberately does NOT decide validity — the engine re-checks
 * with `verifySlotCorrection`. `detect` short-circuits (no model call) when the completed
 * routine declares no mutable slots, so the common post-completion turn stays cheap.
 */
export class RoutineSlotCorrector implements ConversationRoutineSlotCorrection {
  private readonly routinesById: Map<string, Routine>;
  private readonly detectPrompt: string;
  private readonly confirmPrompt: string;

  private readonly invalidPrompt: string;

  constructor(
    routines: readonly Routine[],
    private readonly modelGateway: ConversationModelGateway,
    options: { detectPromptTemplate?: string; confirmPromptTemplate?: string; invalidPromptTemplate?: string } = {},
  ) {
    this.routinesById = new Map(routines.map((routine) => [routine.id, routine]));
    this.detectPrompt = options.detectPromptTemplate ?? DEFAULT_ROUTINE_SLOT_CORRECTION_DETECT_PROMPT;
    this.confirmPrompt = options.confirmPromptTemplate ?? DEFAULT_ROUTINE_SLOT_CORRECTION_CONFIRM_PROMPT;
    this.invalidPrompt = options.invalidPromptTemplate ?? DEFAULT_ROUTINE_SLOT_CORRECTION_INVALID_PROMPT;
  }

  async detect(input: { turn: TurnContext; completedState: RoutineState }): Promise<RoutineSlotCorrectionCandidate | null> {
    const routine = this.routinesById.get(input.completedState.routineId);
    if (!routine) {
      return null;
    }
    const slots = routine.slots ?? [];
    const mutableSlots = slots.filter((slot) => slot.mutable);
    if (mutableSlots.length === 0) {
      return null;
    }
    const mutableKeys = new Set(mutableSlots.map((slot) => slot.key));
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt: renderPromptTemplate("chat/routine-slot-correction-detect.md", this.detectPrompt, {
        slots: slotsBlock(mutableSlots),
      }),
      metadata: {
        routineSlotCorrectionDetect: true,
        agentId: input.turn.agent.id,
      },
    });
    const detected = parseDetection(text, mutableKeys);
    if (!detected) {
      return null;
    }
    // Pass the full declared slot schema so the engine verifies against the real type +
    // mutability, not just the subset shown to the model.
    return { slots, slotKey: detected.slotKey, rawValue: detected.value };
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
