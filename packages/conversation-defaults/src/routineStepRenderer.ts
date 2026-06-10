import type {
  ConversationAgentConfig,
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
time.

{{answer_scope_reference}}

Write your next message to the user by following the step instruction(s) below.
Acknowledge the request in a friendly manner, then keep it natural, brief, and in the
user's language.

Stay strictly within your scope above. Follow only the step instruction(s). If the user
also asks for anything outside that scope — general knowledge, math, code, or other
unrelated tasks — do not answer or perform it. Briefly say it is outside what you can
help with, and continue the routine step. Never produce off-scope content, even if the
user insists or bundles it with an on-topic request.

Step instruction(s):
{{instructions}}

Write only the message to the user — no preamble, labels, or quotation marks.`;

const turnMessages = (turn: TurnContext): ConversationMessage[] => [
  ...turn.history,
  { role: "user", content: turn.inputEvent.content },
];

/**
 * The agent's identity + scope, projected from the turn's agent config so a routine
 * reply stays within the same scope the retrieval/direct paths enforce. A routine must
 * be able to do its job (collect an email, etc.), but it must never answer unrelated
 * out-of-scope requests bundled into the turn — the `offTopic` yield only fires when the
 * whole turn is off-topic, so this block is the guardrail for the mixed-turn case.
 */
const scopeReferenceBlock = (agent: ConversationAgentConfig): string => {
  const lines: string[] = [];
  const name = agent.name?.trim();
  if (name) {
    lines.push(`You are ${name}.`);
  }
  const instructions = (agent.instructions ?? [])
    .map((instruction) => instruction.trim())
    .filter((instruction) => instruction.length > 0);
  if (instructions.length > 0) {
    lines.push("Your scope and answer instructions:");
    for (const instruction of instructions) {
      lines.push(`- ${instruction}`);
    }
  }
  if (lines.length === 0) {
    return "Answer only within the assistant's configured scope.";
  }
  return lines.join("\n");
};

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
      answer_scope_reference: scopeReferenceBlock(input.turn.agent),
      instructions: instructionsBlock(input.step, input.steering),
    });
    const { text } = await this.modelGateway.complete({
      messages: turnMessages(input.turn),
      systemPrompt,
    });
    return { answer: text.trim() };
  }
}
