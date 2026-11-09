import type {
  ConversationMessage,
  ConversationModelCompletion,
  ConversationModelGateway,
  ConversationModelRequest,
  ConversationModelStopReason,
  ConversationRoutineNextStepSelector,
  Routine,
  RoutineNextStepDecision,
  RoutineSelectionTrace,
  RoutineSkillResult,
  RoutineSlotSchema,
  RoutineSlotType,
  RoutineState,
  RoutineStep,
  RoutineTransition,
  RoutineUnreadableReason,
  TurnContext,
} from "@radioso/conversation-contract";
import { checkSlotValue, collectedSlotsForStep } from "@radioso/conversation-engine";

import {
  DEFAULT_ROUTINE_NEXT_STEP_DATE_RULE_PROMPT,
  DEFAULT_ROUTINE_NEXT_STEP_FILLED_SLOTS_PROMPT,
  DEFAULT_ROUTINE_NEXT_STEP_PROMPT,
  DEFAULT_ROUTINE_NEXT_STEP_SLOT_FALLBACK_PROMPT,
  DEFAULT_ROUTINE_NEXT_STEP_SLOTS_PROMPT,
} from "./generated/defaultPrompts.js";
import { localIsoDate, turnTimeZone, type LocalDate } from "./localDate.js";
import { renderPromptTemplate } from "./promptTemplate.js";

export { DEFAULT_ROUTINE_NEXT_STEP_PROMPT } from "./generated/defaultPrompts.js";
export type { RoutineUnreadableReason } from "@radioso/conversation-contract";

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

const skillResultBlock = (skillResult?: RoutineSkillResult): string => {
  if (!skillResult) {
    return "";
  }
  const outputs = skillResult.outputs ? ` Outputs: ${JSON.stringify(skillResult.outputs)}.` : "";
  return `A tool just ran for this step with status "${skillResult.status}".${outputs}`;
};

// An instruction is quoted, and marked as the assistant's: spliced in as plain text, one that
// scripted a greeting and a question was carried out on a routine's opening turn, and the
// selector answered the visitor instead of deciding (#1665). Only writing its message is
// forbidden: its slot references say which slot an accepted value fills, and told to set the
// instruction aside, the model took a "yes" to offered dates and returned neither date.
// A step without an instruction is named.
const currentStepBlock = (step: RoutineStep, skillResult?: RoutineSkillResult): string => {
  if (step.action) {
    return [
      "The instruction the assistant follows when it writes to the user on the current step is",
      "quoted below for context. It is not addressed to you: do not write the message it describes.",
      "",
      "<current_step>",
      step.action,
      "</current_step>",
    ].join("\n");
  }
  if (step.kind === "skill") {
    return `The current step is "${step.id}", which runs a skill${skillResult ? "; its result is below" : ""}.`;
  }
  return `The current step is "${step.id}".`;
};

const slotLine = (slot: RoutineSlotSchema): string => {
  const description = slot.description?.replace(/\s+/g, " ").trim();
  return `- ${slot.key} (${slot.type})${description ? `: ${description}` : ""}`;
};

/** The templates the selector's slot rules are written from (`chat/routine-next-step-*.md`). */
interface SlotRuleTemplates {
  slots: string;
  filledSlots: string;
  dateRule: string;
}

// A date slot without today's date left the model unsure how to write "11 novembre": it
// dropped the value or stored it verbatim, so the hand-off received free text. The format
// is stated as how to record the value, never as the slot's type: shown as the type, the
// model read it as the format the user must type and re-asked a date it had already
// captured, and parsed "11-14 Nov" as month 11, day 14.
const dateRule = (today: LocalDate, template: string): string =>
  renderPromptTemplate("chat/routine-next-step-date-rule.md", template, {
    today: today.isoDate,
    time_zone: today.timeZone,
  });

// Keys only: whether a slot already holds a value is what a condition such as "the user
// provided {{slot.arrival}}" turns on, and without it a value given on an earlier turn
// looked missing, so the step re-asked for it.
const filledSlotKeys = (routine: Routine, variables: Record<string, unknown>): string[] =>
  (routine.slots ?? [])
    .filter((slot) => Object.prototype.hasOwnProperty.call(variables, slot.key))
    .map((slot) => slot.key);

// One readable line per slot, not the raw schema JSON. With the JSON dump the model
// returned no values at all whenever the current step's own question went unanswered,
// dropping slots the message plainly gave (#1370: a first message stating two dates kept
// them in 0 of 20 samples; with this block and the date rule, in 19–20 of 20).
// The value-assignment rules (#1664): without them, a bare "30 ottobre" with an arrival and
// a departure slot landed in either one, and a "yes" to dates the step had just offered
// filled neither, since the message itself states no value. Framing the whole message as a
// reply to the last question went too far: answers were mapped onto whatever was asked
// ("1 novembre" filled the course after "which course?"), and a date the opening message
// gave for another slot was dropped. Acceptance covers only what the assistant proposed: a
// step that reads held values back and asks to confirm also runs the selector (through its
// AI-decided exit), and read as a proposal, the "yes" replaced the user's own words with the
// assistant's paraphrase. The proposer is named as "the assistant", never "you": the
// selector is told it never writes to the user (#1665).
const slotSchemaBlock = (
  routine: Routine,
  variables: Record<string, unknown>,
  today: LocalDate,
  templates: SlotRuleTemplates,
): string => {
  if (!routine.slots || routine.slots.length === 0) {
    return "";
  }
  const filled = filledSlotKeys(routine, variables);
  return renderPromptTemplate("chat/routine-next-step-slots.md", templates.slots, {
    slot_lines: routine.slots.map(slotLine).join("\n"),
    filled_slots: filled.length > 0
      ? `\n${renderPromptTemplate("chat/routine-next-step-filled-slots.md", templates.filledSlots, {
        slot_keys: filled.join(", "),
      })}`
      : "",
    date_rule: routine.slots.some((slot) => slot.type === "date") ? `\n${dateRule(today, templates.dateRule)}` : "",
  });
};

/**
 * Which of the selector's model calls a completion answers:
 * - `decision`: the call that decides the turn.
 * - `retry`: the identical call, sent once when the decision came back unreadable.
 * - `slot_fallback`: the slot-only reading, sent once on a step that collects slots when the
 *   retry came back unreadable too.
 */
export type RoutineSelectorCall = "decision" | "retry" | "slot_fallback";

/**
 * One completion the selector read, identified by routine, step and session for correlation in
 * logs, and described by its labels, sizes and stop reason only, never its text.
 */
export interface RoutineSelectorCompletionEvent {
  routineId: string;
  stepId: string;
  /** The current step's kind. */
  stepKind: RoutineStep["kind"];
  sessionId: string;
  call: RoutineSelectorCall;
  /** Why the completion could not be read; absent when it was read. */
  unreadableReason?: RoutineUnreadableReason;
  /** The model that wrote it, when the gateway reports it. */
  model?: string;
  /** Why the model stopped, when the gateway reports it. */
  stopReason?: ConversationModelStopReason;
  /** Length of the completion's text in UTF-16 code units (JavaScript string length); 0 for a blank completion. */
  outputChars: number;
  /**
   * Length of the system prompt plus every message's content, in UTF-16 code units: the text
   * the selector sent, not the size of the serialized request.
   */
  promptChars: number;
}

/**
 * Notified for each completion the selector reads, readable or not, so a host can count how
 * often each model's completions come back unreadable. Purely observational — the selector
 * calls it best-effort and swallows anything it throws, so a broken observer cannot fail the
 * turn.
 */
export type RoutineSelectorCompletionObserver = (event: RoutineSelectorCompletionEvent) => void;

const ignoreCompletion: RoutineSelectorCompletionObserver = () => {};

interface ParsedDecision {
  /** Absent when the completion was read; the reason it wasn't, when it couldn't be. */
  unreadableReason?: RoutineUnreadableReason;
  condition: number | null;
  offTopic: boolean;
  /** The model read text in the message posing as a system notice or claiming the request is already confirmed. */
  claimsAuthority: boolean;
  variables: Record<string, unknown>;
}

const unreadableDecision = (reason: RoutineUnreadableReason): ParsedDecision => ({
  unreadableReason: reason,
  condition: null,
  offTopic: false,
  claimsAuthority: false,
  variables: {},
});

// Extracts the first balanced { ... } object from the model output. Structural
// parsing only; no product vocabulary.
const extractJsonObject = (raw: string): string | null => {
  const start = raw.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, index + 1);
      }
    }
  }
  return null;
};

// Cancellation, not a parsing failure: the turn itself is going away, so the retry below
// must let this propagate rather than keep retrying or falling back to a stale decision.
const isAbortError = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

const requestChars = (request: ConversationModelRequest): number =>
  (request.systemPrompt ?? "").length + request.messages.reduce((total, message) => total + message.content.length, 0);

/** What a completion looked like, by its model, sizes and stop reason only. */
const completionShape = (
  completion: ConversationModelCompletion,
  request: ConversationModelRequest,
): Pick<RoutineSelectorCompletionEvent, "model" | "stopReason" | "outputChars" | "promptChars"> => ({
  ...(completion.model ? { model: completion.model } : {}),
  ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
  outputChars: completion.text.length,
  promptChars: requestChars(request),
});

/**
 * The slot-only reading: the values it returned, or, when it could not be read, why and none.
 * Like a decision, it is unreadable without a boolean `claimsAuthority`, and a message it
 * flags keeps no value (#1375).
 */
interface SlotReading {
  unreadableReason?: RoutineUnreadableReason;
  claimsAuthority: boolean;
  variables: Record<string, unknown>;
}

const unreadableSlotReading = (reason: RoutineUnreadableReason): SlotReading =>
  ({ unreadableReason: reason, claimsAuthority: false, variables: {} });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSlotReading = (raw: string): SlotReading => {
  const json = extractJsonObject(raw.trim());
  if (!json) {
    return unreadableSlotReading("no_json_object");
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isPlainObject(parsed) || !isPlainObject(parsed.variables) || typeof parsed.claimsAuthority !== "boolean") {
      return unreadableSlotReading("missing_required_fields");
    }
    return parsed.claimsAuthority
      ? { claimsAuthority: true, variables: {} }
      : { claimsAuthority: false, variables: parsed.variables };
  } catch {
    return unreadableSlotReading("invalid_json");
  }
};

const slotFallbackOutcome = (reading: SlotReading): NonNullable<RoutineSelectionTrace["slotFallback"]> => {
  if (reading.unreadableReason) {
    return "unreadable";
  }
  return reading.claimsAuthority ? "authority_claim" : "read";
};

const parseDecision = (raw: string): ParsedDecision => {
  const json = extractJsonObject(raw.trim());
  if (!json) {
    return unreadableDecision("no_json_object");
  }
  try {
    const parsed = JSON.parse(json) as { condition?: unknown; offTopic?: unknown; claimsAuthority?: unknown; variables?: unknown };
    // Without the flag nothing says the message was checked for text posing as a system
    // notice, so the output counts as unreadable: nothing chosen, nothing kept.
    if (typeof parsed.claimsAuthority !== "boolean") {
      return unreadableDecision("missing_required_fields");
    }
    const claimsAuthority = parsed.claimsAuthority;
    const condition = typeof parsed.condition === "number" ? parsed.condition : null;
    const offTopic = parsed.offTopic === true;
    const variables =
      parsed.variables && typeof parsed.variables === "object" && !Array.isArray(parsed.variables)
        ? (parsed.variables as Record<string, unknown>)
        : {};
    return { condition, offTopic, claimsAuthority, variables };
  } catch {
    return unreadableDecision("invalid_json");
  }
};

// The model often writes a number or boolean as a JSON string; a field guard compares with
// `===`, so "2" would never equal 2. Coerced by the engine's slot value rules; a value that
// does not fit its declared type passes through unchanged for the runner to reject and
// record (#1374).
const coerceToSlotType = (value: unknown, type: RoutineSlotType | undefined): unknown => {
  const checked = type ? checkSlotValue(type, value) : null;
  return checked?.ok ? checked.value : value;
};

// Structural check: a literal template placeholder (e.g. "<name>") echoed verbatim by
// the model from the prompt example — never a real slot key.
const PLACEHOLDER_KEY_PATTERN = /^<.*>$/;

/**
 * Keep only legitimately captured slot values. Drops placeholder keys the model echoes
 * from the prompt example, and — when the routine declares a slot schema — restricts
 * capture to declared slot keys so a bundled off-topic request cannot smuggle arbitrary
 * keys (or free-form turn text) into the action payload. Schema-less routines keep their
 * legacy free-form capture, minus placeholder echoes.
 */
const sanitizeVariables = (
  variables: Record<string, unknown>,
  routine: Routine,
): { captured: Record<string, unknown>; undeclaredKeyCount: number } => {
  const slotTypes = new Map((routine.slots ?? []).map((slot) => [slot.key, slot.type]));
  const captured: Record<string, unknown> = {};
  let undeclaredKeyCount = 0;
  for (const [key, value] of Object.entries(variables)) {
    if (PLACEHOLDER_KEY_PATTERN.test(key) || (slotTypes.size > 0 && !slotTypes.has(key))) {
      undeclaredKeyCount += 1;
      continue;
    }
    // A null or blank value is the model saying "not given"; kept, it would count as filled.
    if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) {
      continue;
    }
    captured[key] = coerceToSlotType(value, slotTypes.get(key));
  }
  return { captured, undeclaredKeyCount };
};

const selectionOutcome = (decision: ParsedDecision, conditionMatched: boolean): RoutineSelectionTrace["outcome"] => {
  if (decision.unreadableReason) {
    return "unreadable";
  }
  if (decision.claimsAuthority) {
    return "authority_claim";
  }
  if (conditionMatched) {
    return "transition";
  }
  return decision.offTopic ? "off_topic" : "stay";
};

const selectionTrace = (
  decision: ParsedDecision,
  conditionMatched: boolean,
  { captured, undeclaredKeyCount }: ReturnType<typeof sanitizeVariables>,
  /** Whether the selector retried after its first completion came back unreadable. */
  retried: boolean,
  slotFallback: RoutineSelectionTrace["slotFallback"],
): RoutineSelectionTrace => {
  const returnedSlotKeys = Object.keys(captured);
  return {
    outcome: selectionOutcome(decision, conditionMatched),
    returnedSlotKeys,
    ...(undeclaredKeyCount > 0 ? { undeclaredKeyCount } : {}),
    ...(decision.unreadableReason ? { unreadableReason: decision.unreadableReason } : {}),
    ...(retried ? { retried: true as const } : {}),
    ...(slotFallback ? { slotFallback } : {}),
  };
};

// A retry or slot-only call failing for its own reason (a transient provider error, say) must
// not fail a turn that would otherwise re-ask the step: the caller keeps what it already has.
// Cancellation is not such a failure — the turn itself is going away — so it propagates.
const unlessCallFails = async <T>(call: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await call();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return undefined;
  }
};

/**
 * Decides which step a routine turn lands on by asking the model which outgoing
 * transition's condition holds, capturing any slot variables — the host-side
 * `ConversationRoutineNextStepSelector` the engine's runner calls. The decision is
 * an LLM-returned structured choice over the transition conditions (judged by
 * meaning, not keywords), never an English keyword list.
 */
export class RoutineNextStepSelector implements ConversationRoutineNextStepSelector {
  private readonly promptTemplate: string;
  private readonly slotFallbackPromptTemplate: string;
  private readonly slotRuleTemplates: SlotRuleTemplates;
  private readonly clock: () => Date;
  private readonly onCompletion: RoutineSelectorCompletionObserver;

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    /** `clock` dates the turn so a date slot given without a year resolves; defaults to the wall clock. */
    options: {
      promptTemplate?: string;
      /** The slot-only reading after two unreadable decisions (`{{slotSchema}}`). */
      slotFallbackPromptTemplate?: string;
      /** The declared slots and the rules for filling them (`{{slot_lines}}`, `{{filled_slots}}`, `{{date_rule}}`). */
      slotsPromptTemplate?: string;
      /** The slots that already hold a value (`{{slot_keys}}`). */
      filledSlotsPromptTemplate?: string;
      /** How a date slot's value is read and recorded (`{{today}}`, `{{time_zone}}`). */
      dateRulePromptTemplate?: string;
      clock?: () => Date;
      onCompletion?: RoutineSelectorCompletionObserver;
    } = {},
  ) {
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_NEXT_STEP_PROMPT;
    this.slotFallbackPromptTemplate = options.slotFallbackPromptTemplate ?? DEFAULT_ROUTINE_NEXT_STEP_SLOT_FALLBACK_PROMPT;
    this.slotRuleTemplates = {
      slots: options.slotsPromptTemplate ?? DEFAULT_ROUTINE_NEXT_STEP_SLOTS_PROMPT,
      filledSlots: options.filledSlotsPromptTemplate ?? DEFAULT_ROUTINE_NEXT_STEP_FILLED_SLOTS_PROMPT,
      dateRule: options.dateRulePromptTemplate ?? DEFAULT_ROUTINE_NEXT_STEP_DATE_RULE_PROMPT,
    };
    this.clock = options.clock ?? (() => new Date());
    this.onCompletion = options.onCompletion ?? ignoreCompletion;
  }

  async select(input: {
    routine: Routine;
    state: RoutineState;
    currentStep: RoutineStep;
    transitions: RoutineTransition[];
    turn: TurnContext;
    skillResult?: RoutineSkillResult;
    messageStatesSlotValues?: boolean;
  }): Promise<RoutineNextStepDecision> {
    // No outgoing edges → nowhere to advance; stay on the current step.
    if (input.transitions.length === 0) {
      return { nextStepId: input.currentStep.id, variables: {} };
    }

    const conditions = input.transitions
      .map((transition, index) => `${index + 1}. ${transition.condition}`)
      .join("\n");
    const slotSchema = slotSchemaBlock(
      input.routine,
      input.state.variables,
      localIsoDate(this.clock(), turnTimeZone(input.turn)),
      this.slotRuleTemplates,
    );
    const systemPrompt = renderPromptTemplate("chat/routine-next-step.md", this.promptTemplate, {
      currentStep: currentStepBlock(input.currentStep, input.skillResult),
      skillResult: skillResultBlock(input.skillResult),
      conditions,
      slotSchema,
    });

    // A blank completion comes back as one, so it is read, retried and reported like any other
    // unreadable reply, with its stop reason, rather than retried out of sight by the host.
    const request: ConversationModelRequest = { messages: turnMessages(input.turn), systemPrompt, returnBlank: true };

    // Completes one call, reads its completion, and reports it to the observer, which is purely
    // observational: one that throws must not fail the turn, so every call to it is isolated here.
    const read = async <T extends { unreadableReason?: RoutineUnreadableReason }>(
      call: RoutineSelectorCall,
      callRequest: ConversationModelRequest,
      parse: (raw: string) => T,
    ): Promise<T> => {
      const completion = await this.modelGateway.complete(callRequest);
      const reading = parse(completion.text);
      try {
        this.onCompletion({
          routineId: input.routine.id,
          stepId: input.currentStep.id,
          stepKind: input.currentStep.kind,
          sessionId: input.state.sessionId,
          call,
          ...(reading.unreadableReason ? { unreadableReason: reading.unreadableReason } : {}),
          ...completionShape(completion, callRequest),
        });
      } catch {
        // Swallowed — see above.
      }
      return reading;
    };

    let decision = await read("decision", request, parseDecision);
    let retried = false;
    if (decision.unreadableReason) {
      retried = true;
      // The selector only reads this turn and chooses an exit; it has no side effects of its
      // own, so repeating the exact same request is safe — it can only replace one unreadable
      // completion with a readable one, never double an action.
      decision = (await unlessCallFails(() => read("retry", request, parseDecision))) ?? decision;
    }
    // Both decisions unreadable on a step that collects slots: one narrower call reads the
    // message for slot values only (#1715). In production a contact step's decision came back
    // blank twice for the same message, which an identical retry cannot change, and the visitor's
    // name and email were lost. It chooses no exit. A structured call's values are never kept,
    // so there it is not made.
    const readsSlots = input.messageStatesSlotValues !== false && collectedSlotsForStep(input.currentStep).length > 0;
    const slotReading = decision.unreadableReason && slotSchema && readsSlots
      ? await unlessCallFails(() => read("slot_fallback", {
        messages: request.messages,
        systemPrompt: renderPromptTemplate("chat/routine-next-step-slot-fallback.md", this.slotFallbackPromptTemplate, { slotSchema }),
        returnBlank: true,
      }, parseSlotReading))
      : undefined;

    const conditionMatched =
      decision.condition !== null && decision.condition >= 1 && decision.condition <= input.transitions.length;
    const sanitized = sanitizeVariables(slotReading?.variables ?? decision.variables, input.routine);
    const variables = sanitized.captured;
    const selection = selectionTrace(decision, conditionMatched, sanitized, retried, slotReading && slotFallbackOutcome(slotReading));

    // No exit was judged: the runner then keeps a step from taking an exit a model must judge,
    // or a rule or default exit in its place. A message the slot-only reading flags as posing
    // as a system notice holds the step, as a flagged decision does.
    if (decision.unreadableReason) {
      const exitsUnjudged = slotReading && !slotReading.unreadableReason ? "read" : "unread";
      return {
        nextStepId: input.currentStep.id,
        variables,
        ...(slotReading?.claimsAuthority ? { hold: true } : {}),
        exitsUnjudged,
        selection,
      };
    }

    // A flagged message holds the step (see `hold` on the decision), whatever condition the
    // model chose, because the model flags such text yet still picks the exit it asks for.
    if (decision.claimsAuthority) {
      return { nextStepId: input.currentStep.id, variables, hold: true, selection };
    }

    // A matched transition advances regardless of anything else (the user supplied what
    // the step asked for, possibly alongside a question).
    if (conditionMatched) {
      return { nextStepId: input.transitions[decision.condition! - 1].to, variables, selection };
    }

    // No transition matched, but the user asked something unrelated → yield the turn so
    // normal answering handles it; the routine stays parked here to resume later.
    if (decision.offTopic) {
      return { nextStepId: input.currentStep.id, yieldTurn: true, selection };
    }

    // Otherwise the user is still on this step but hasn't satisfied it → stay (a re-ask),
    // keeping any captured variables so partial progress is not lost.
    return { nextStepId: input.currentStep.id, variables, selection };
  }
}
