import type {
  ConversationMessage,
  ConversationModelGateway,
  ConversationRoutineNextStepSelector,
  Routine,
  RoutineNextStepDecision,
  RoutineSkillResult,
  RoutineState,
  RoutineStep,
  RoutineTransition,
  TurnContext,
} from "@radioso/conversation-contract";

import { DEFAULT_ROUTINE_NEXT_STEP_PROMPT } from "./generated/defaultPrompts.js";
import { renderPromptTemplate } from "./promptTemplate.js";

export { DEFAULT_ROUTINE_NEXT_STEP_PROMPT } from "./generated/defaultPrompts.js";

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

const slotSchemaBlock = (routine: Routine): string => {
  if (!routine.slots || routine.slots.length === 0) {
    return "";
  }
  return [
    "Declared slot schema:",
    JSON.stringify(routine.slots),
    "",
    "Extract every declared slot present in the latest user message in one pass.",
    'Return extracted values in "variables" keyed by each slot\'s "key"; omit slots not provided this turn.',
  ].join("\n");
};

interface ParsedDecision {
  condition: number | null;
  offTopic: boolean;
  variables: Record<string, unknown>;
}

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

const parseDecision = (raw: string): ParsedDecision => {
  const json = extractJsonObject(raw.trim());
  if (!json) {
    return { condition: null, offTopic: false, variables: {} };
  }
  try {
    const parsed = JSON.parse(json) as { condition?: unknown; offTopic?: unknown; variables?: unknown };
    const condition = typeof parsed.condition === "number" ? parsed.condition : null;
    const offTopic = parsed.offTopic === true;
    const variables =
      parsed.variables && typeof parsed.variables === "object" && !Array.isArray(parsed.variables)
        ? (parsed.variables as Record<string, unknown>)
        : {};
    return { condition, offTopic, variables };
  } catch {
    return { condition: null, offTopic: false, variables: {} };
  }
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
): Record<string, unknown> => {
  const declaredKeys = new Set((routine.slots ?? []).map((slot) => slot.key));
  return Object.fromEntries(
    Object.entries(variables).filter(([key]) => {
      if (PLACEHOLDER_KEY_PATTERN.test(key)) {
        return false;
      }
      return declaredKeys.size === 0 || declaredKeys.has(key);
    }),
  );
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

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    options: { promptTemplate?: string } = {},
  ) {
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_NEXT_STEP_PROMPT;
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
      slotSchema: slotSchemaBlock(input.routine),
    });

    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt,
    });
    const decision = parseDecision(text);

    const conditionMatched =
      decision.condition !== null && decision.condition >= 1 && decision.condition <= input.transitions.length;

    // A matched transition advances regardless of anything else (the user supplied what
    // the step asked for, possibly alongside a question).
    if (conditionMatched) {
      return {
        nextStepId: input.transitions[decision.condition! - 1]!.to,
        variables: sanitizeVariables(decision.variables, input.routine),
      };
    }

    // No transition matched, but the user asked something unrelated → yield the turn so
    // normal answering handles it; the routine stays parked here to resume later.
    if (decision.offTopic) {
      return { nextStepId: input.currentStep.id, yieldTurn: true };
    }

    // Otherwise the user is still on this step but hasn't satisfied it → stay (a re-ask),
    // keeping any captured variables so partial progress is not lost.
    return { nextStepId: input.currentStep.id, variables: sanitizeVariables(decision.variables, input.routine) };
  }
}
