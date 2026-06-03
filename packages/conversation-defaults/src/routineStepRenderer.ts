import type {
  ConversationMessage,
  ConversationModelGateway,
  ConversationRoutineStepRenderer,
  RenderableTurn,
  RoutineStep,
  SteeringRule,
  TurnContext,
} from "@radioso/conversation-contract";

import { renderPromptTemplate } from "./promptTemplate.js";

export const DEFAULT_ROUTINE_STEP_REPLY_PROMPT = `You are the assistant, guiding the user through a structured routine one step at a
time. Write your next message to the user by following the step instruction(s)
below. Acknowledge the request in a friendly manner, then keep it natural, brief, and in the user's language.

Step instruction(s):
{{instructions}}

Write only the message to the user — no preamble, labels, or quotation marks.`;

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

const instructionsBlock = (step: RoutineStep, steering: SteeringRule[]): string => {
  const actions = steering.map((rule) => rule.action);
  // The projected step steering is the source of truth; fall back to the step's own
  // action so a step with no projected steering still renders something.
  if (actions.length === 0 && step.action) {
    actions.push(step.action);
  }
  return actions.map((action) => `- ${action}`).join("\n");
};

/**
 * Renders a routine step's reply by generating a message that follows the step's
 * projected steering — the host-side `ConversationRoutineStepRenderer` the engine's
 * runner calls. Generation goes through the conversation model gateway (the host
 * wires a workspace/usage-aware one); the routine step never hard-codes copy, so
 * the wording stays LLM-owned and multilingual.
 */
export class RoutineStepRenderer implements ConversationRoutineStepRenderer {
  private readonly promptTemplate: string;

  constructor(
    private readonly modelGateway: ConversationModelGateway,
    options: { promptTemplate?: string } = {},
  ) {
    this.promptTemplate = options.promptTemplate ?? DEFAULT_ROUTINE_STEP_REPLY_PROMPT;
  }

  async render(input: {
    step: RoutineStep;
    steering: SteeringRule[];
    turn: TurnContext;
  }): Promise<RenderableTurn> {
    const systemPrompt = renderPromptTemplate("chat/routine-step-reply.md", this.promptTemplate, {
      instructions: instructionsBlock(input.step, input.steering),
    });
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt,
    });
    return { answer: text.trim() };
  }
}
