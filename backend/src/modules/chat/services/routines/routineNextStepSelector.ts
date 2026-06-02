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

import { renderPromptTemplate } from "../../../../shared/infra/prompts/promptLoader.js";
import { extractFirstJsonObject } from "./jsonScan.js";

const NEXT_STEP_PROMPT = "chat/routine-next-step.md";

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

const parseDecision = (raw: string): ParsedDecision => {
  const json = extractFirstJsonObject(raw.trim());
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
 * meaning, not keywords), never an English keyword list; the prompt lives under
 * `backend/prompts/`.
 */
export class RoutineNextStepSelector implements ConversationRoutineNextStepSelector {
  constructor(private readonly modelGateway: ConversationModelGateway) {}

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
    const systemPrompt = renderPromptTemplate(NEXT_STEP_PROMPT, {
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
