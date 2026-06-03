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

export const DEFAULT_ROUTINE_NEXT_STEP_PROMPT = `You are guiding a user through a structured, multi-step routine. Decide which step
the conversation should move to next, based on what the user just said.

The current step's instruction to the user was:
{{currentStep}}

{{skillResult}}

The possible next steps are numbered below. Each has a condition describing when it
applies. A condition may be written in any language and the conversation may be in
any language — judge by meaning, not by matching words.

{{conditions}}

Return a JSON object:

{"condition": <the number of the one condition that holds, or null if none holds yet>, "variables": {"<name>": "<value the user provided this turn>"}}

Rules:

- Return the number of exactly one condition that clearly holds. Return null to stay
  on the current step (for example, the user has not yet provided what was asked, or
  asked something unrelated).
- Put into "variables" only values the user actually provided this turn (for example
  an email address or a message). Use an empty object {} when there are none.
- Return only the JSON object, with no other text.`;

const renderPromptTemplate = (template: string, values: Record<string, string>): string => {
  let rendered = template;
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value);
  }
  return rendered;
};

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

interface ParsedDecision {
  condition: number | null;
  variables: Record<string, unknown>;
}

// Extracts the first balanced { ... } object from the model output (it may wrap the
// JSON in prose or a code fence). A string-aware balanced scan — not a greedy `{.*}`
// regex — so trailing prose, a second object, nested braces, and braces *inside a
// captured value* (e.g. a user message containing "}") don't truncate or capture the
// wrong span. Structural parsing only — no product vocabulary.
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
    return { condition: null, variables: {} };
  }
  try {
    const parsed = JSON.parse(json) as { condition?: unknown; variables?: unknown };
    const condition = typeof parsed.condition === "number" ? parsed.condition : null;
    const variables =
      parsed.variables && typeof parsed.variables === "object" && !Array.isArray(parsed.variables)
        ? (parsed.variables as Record<string, unknown>)
        : {};
    return { condition, variables };
  } catch {
    return { condition: null, variables: {} };
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
    const systemPrompt = renderPromptTemplate(this.promptTemplate, {
      currentStep: input.currentStep.action ?? input.currentStep.id,
      skillResult: skillResultBlock(input.skillResult),
      conditions,
    });

    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt,
    });
    const decision = parseDecision(text);

    // Out of range / null → stay on the current step (a re-ask), keeping any captured
    // variables so partial progress is not lost.
    if (decision.condition === null || decision.condition < 1 || decision.condition > input.transitions.length) {
      return { nextStepId: input.currentStep.id, variables: decision.variables };
    }
    return {
      nextStepId: input.transitions[decision.condition - 1]!.to,
      variables: decision.variables,
    };
  }
}
