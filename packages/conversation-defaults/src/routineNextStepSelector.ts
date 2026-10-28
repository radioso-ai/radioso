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
import { checkSlotValue } from "@radioso/conversation-engine";

import { DEFAULT_ROUTINE_NEXT_STEP_PROMPT } from "./generated/defaultPrompts.js";
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

const slotLine = (slot: RoutineSlotSchema): string => {
  const description = slot.description?.replace(/\s+/g, " ").trim();
  return `- ${slot.key} (${slot.type})${description ? `: ${description}` : ""}`;
};

// A date slot without today's date left the model unsure how to write "11 novembre": it
// dropped the value or stored it verbatim, so the hand-off received free text. The format
// is stated as how to record the value, never as the slot's type: shown as the type, the
// model read it as the format the user must type and re-asked a date it had already
// captured, and parsed "11-14 Nov" as month 11, day 14.
const dateRule = (today: Date): string =>
  [
    "The user may write a date in any form; a date they give for a date slot counts as provided.",
    'Record a date slot\'s value as YYYY-MM-DD, reading the day and month the way the user wrote them: "11-14 Nov" is 11 to 14 November.',
    `Today is ${today.toISOString().slice(0, 10)} (UTC); a date given without a year is its next occurrence on or after today.`,
    'Leave a date slot out when the user names only an approximate time, such as "mid-November" or "in spring".',
  ].join(" ");

// One readable line per slot, not the raw schema JSON. With the JSON dump the model
// returned no values at all whenever the current step's own question went unanswered,
// dropping slots the message plainly gave (#1370: a first message stating two dates kept
// them in 0 of 20 samples; with this block and the date rule, in 19–20 of 20).
// Keys only: whether a slot already holds a value is what a condition such as "the user
// provided {{slot.arrival}}" turns on, and without it a value given on an earlier turn
// looked missing, so the step re-asked for it.
const filledSlotsLine = (routine: Routine, variables: Record<string, unknown>): string[] => {
  const filled = (routine.slots ?? []).filter((slot) => Object.prototype.hasOwnProperty.call(variables, slot.key));
  return filled.length > 0 ? [`Slots that already have a value from earlier turns: ${filled.map((slot) => slot.key).join(", ")}.`] : [];
};

// Without these (#1664), a bare "30 ottobre" with an arrival and a departure slot landed in
// either one, and a "yes" to dates the step had just offered filled neither, since the
// message itself states no value. Framing the whole message as a reply to the last question
// went too far: answers were mapped onto whatever was asked ("1 novembre" filled the course
// after "which course?"), and a date the opening message gave for another slot was dropped.
const slotAssignmentRules = [
  "A value that could fill more than one slot goes in none of them unless the message or the conversation before it makes clear which one it is for. One value goes into two slots only when the message gives it for both.",
  "When the assistant's last message proposed values for slots and the latest message accepts them, in any words, those values are given this turn. Return each proposed value for its slot, replacing any value the slot already holds. A value the user changes while accepting is the one to keep.",
];

const slotSchemaBlock = (routine: Routine, variables: Record<string, unknown>, today: Date): string => {
  if (!routine.slots || routine.slots.length === 0) {
    return "";
  }
  return [
    "Declared slots (key, type, and what each one holds):",
    ...routine.slots.map(slotLine),
    ...filledSlotsLine(routine, variables),
    "",
    "Extract every declared slot present in the latest user message in one pass, whether or not the current step asks for it.",
    "Judge each slot on its own: a slot's description applies only to that slot and never stops you from extracting another.",
    ...slotAssignmentRules,
    "A condition that refers to a slot as {{slot.<key>}} holds only when that slot has a value, given in the latest message or earlier in the conversation; when you return a value for every slot such a condition refers to, it holds.",
    ...(routine.slots.some((slot) => slot.type === "date") ? [dateRule(today)] : []),
    'Return extracted values in "variables" keyed by each slot\'s key; omit slots not provided or accepted this turn.',
  ].join("\n");
};

/**
 * Identifies which routine/step/session produced an unreadable decision, for correlation in
 * logs, and describes the completion by its sizes and stop reason only, never its text.
 */
export interface RoutineUnreadableEvent {
  routineId: string;
  stepId: string;
  sessionId: string;
  reason: RoutineUnreadableReason;
  /** Which completion this was: the original call, or the one retry. */
  attempt: 1 | 2;
  /** Why the model stopped, when the gateway reports it: `output_limit` is a reply cut off at the cap. */
  stopReason?: ConversationModelStopReason;
  /** Length of the completion's text, in characters. */
  outputChars: number;
  /** Length of the request's system prompt and messages together, in characters. */
  promptChars: number;
}

/**
 * Notified for each next-step decision completion that could not be read: after the
 * first, the selector retries once; after the second, it re-asks the step. Purely
 * observational — the selector calls it best-effort and swallows anything it throws, so a
 * broken observer cannot fail the turn.
 */
export type RoutineUnreadableObserver = (event: RoutineUnreadableEvent) => void;

const ignoreUnreadable: RoutineUnreadableObserver = () => {};

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

/** What an unreadable completion looked like, by its sizes and stop reason only. */
const completionShape = (
  completion: ConversationModelCompletion,
  promptChars: number,
): Pick<RoutineUnreadableEvent, "stopReason" | "outputChars" | "promptChars"> => ({
  ...(completion.stopReason ? { stopReason: completion.stopReason } : {}),
  outputChars: completion.text.length,
  promptChars,
});

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
): RoutineSelectionTrace => {
  const returnedSlotKeys = Object.keys(captured);
  return {
    outcome: selectionOutcome(decision, conditionMatched),
    returnedSlotKeys,
    ...(undeclaredKeyCount > 0 ? { undeclaredKeyCount } : {}),
    ...(decision.unreadableReason ? { unreadableReason: decision.unreadableReason } : {}),
    ...(retried ? { retried: true as const } : {}),
  };
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
  private readonly clock: () => Date;
  private readonly onUnreadable: RoutineUnreadableObserver;

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    /** `clock` dates the turn so a date slot given without a year resolves; defaults to the wall clock. */
    options: { promptTemplate?: string; clock?: () => Date; onUnreadable?: RoutineUnreadableObserver } = {},
  ) {
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_NEXT_STEP_PROMPT;
    this.clock = options.clock ?? (() => new Date());
    this.onUnreadable = options.onUnreadable ?? ignoreUnreadable;
  }

  async select(input: {
    routine: Routine;
    state: RoutineState;
    currentStep: RoutineStep;
    transitions: RoutineTransition[];
    turn: TurnContext;
    skillResult?: RoutineSkillResult;
  }): Promise<RoutineNextStepDecision> {
    // No outgoing edges → nowhere to advance; stay on the current step.
    if (input.transitions.length === 0) {
      return { nextStepId: input.currentStep.id, variables: {} };
    }

    const conditions = input.transitions
      .map((transition, index) => `${index + 1}. ${transition.condition}`)
      .join("\n");
    const systemPrompt = renderPromptTemplate("chat/routine-next-step.md", this.promptTemplate, {
      currentStep: input.currentStep.action ?? input.currentStep.id,
      skillResult: skillResultBlock(input.skillResult),
      conditions,
      slotSchema: slotSchemaBlock(input.routine, input.state.variables, this.clock()),
    });

    const request: ConversationModelRequest = { messages: turnMessages(input.turn), systemPrompt };
    const promptChars = requestChars(request);

    // Purely observational: an observer that throws must not fail the turn, so every call
    // to it is isolated here rather than left for each call site to remember.
    const notifyUnreadable = (reason: RoutineUnreadableReason, attempt: 1 | 2, completion: ConversationModelCompletion): void => {
      try {
        this.onUnreadable({
          routineId: input.routine.id,
          stepId: input.currentStep.id,
          sessionId: input.state.sessionId,
          reason,
          attempt,
          ...completionShape(completion, promptChars),
        });
      } catch {
        // Swallowed — see above.
      }
    };

    const completeAndParse = async () => {
      const completion = await this.modelGateway.complete(request);
      return { completion, decision: parseDecision(completion.text) };
    };

    let { completion, decision } = await completeAndParse();
    let retried = false;
    // `attempt` is always 1 or 2 here: the loop condition caps it at 2, and the body breaks
    // before a third increment.
    for (let attempt = 1; decision.unreadableReason && attempt <= 2; attempt += 1) {
      notifyUnreadable(decision.unreadableReason, attempt as 1 | 2, completion);
      if (attempt === 2) {
        break;
      }
      retried = true;
      try {
        // The selector only reads this turn and chooses an exit; it has no side effects of
        // its own, so repeating the exact same request is safe — it can only replace one
        // unreadable completion with a readable one, never double an action.
        ({ completion, decision } = await completeAndParse());
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        // Before this retry existed, an unreadable completion simply re-asked the step; a
        // retry call failing for its own reason (a transient provider error, say) must not
        // regress that — keep the first unreadable decision rather than failing the turn.
        break;
      }
    }

    const conditionMatched =
      decision.condition !== null && decision.condition >= 1 && decision.condition <= input.transitions.length;
    const sanitized = sanitizeVariables(decision.variables, input.routine);
    const variables = sanitized.captured;
    const selection = selectionTrace(decision, conditionMatched, sanitized, retried);

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
