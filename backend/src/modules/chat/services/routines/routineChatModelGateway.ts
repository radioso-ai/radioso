import type {
  ConversationMessage,
  ConversationModelGateway,
} from "@radioso/conversation-contract";

import type { ChatGateway, ChatGatewayUsageContext } from "../../contracts/chatGateway.js";
import { CHAT_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import type { LlmCapabilityResolveInput } from "../../../../shared/infra/llm/workspaceContext.js";

/** The per-turn billing + model-resolution context a routine LLM call needs. */
export interface RoutineModelTurnContext {
  workspaceContext: LlmCapabilityResolveInput;
  usageContext: ChatGatewayUsageContext;
  signal?: AbortSignal;
}

/**
 * Renders the conversation transcript the routine selector/renderer pass as a single
 * prompt string. The host chat gateway is prompt-based (it ignores the structured
 * `query`/`history` fields), so the transcript must live in `prompt`. Roles are
 * structural labels, not product vocabulary.
 */
const serializeTranscript = (messages: ConversationMessage[]): string =>
  messages.map((message) => `${message.role}: ${message.content}`).join("\n");

const lastUserContent = (messages: ConversationMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") {
      return messages[index]!.content;
    }
  }
  return "";
};

const isRoutineActivationCall = (metadata: Record<string, unknown> | undefined): boolean =>
  metadata?.routineActivation === true;

const routineActivationUsageContext = (usageContext: ChatGatewayUsageContext): ChatGatewayUsageContext => ({
  ...usageContext,
  operation: "routine_activation",
  attemptKey: "routine_activation",
});

/**
 * Adapts the host {@link ChatGateway} to the engine's {@link ConversationModelGateway}
 * for routine progression. Built per turn (it carries that turn's usage + workspace
 * context, which are not on the engine's `TurnContext`), it lets the routine next-step
 * selector and step renderer generate through the same workspace/usage-accounted model
 * as normal chat answers. Generation stays LLM-owned; this only bridges the shapes.
 */
export class RoutineChatModelGateway implements ConversationModelGateway {
  constructor(
    private readonly chatGateway: Pick<ChatGateway, "answer">,
    private readonly turn: RoutineModelTurnContext,
  ) {}

  async complete(input: {
    messages: ConversationMessage[];
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ text: string }> {
    const routineActivation = isRoutineActivationCall(input.metadata);
    const text = await this.chatGateway.answer({
      query: lastUserContent(input.messages),
      history: [],
      prompt: serializeTranscript(input.messages),
      systemPrompt: input.systemPrompt,
      workspaceContext: this.turn.workspaceContext,
      usageContext: routineActivation
        ? routineActivationUsageContext(this.turn.usageContext)
        : this.turn.usageContext,
      ...(routineActivation ? { generation: CHAT_BEHAVIOR.intentRouting } : {}),
      ...(this.turn.signal ? { signal: this.turn.signal } : {}),
    });
    return { text };
  }
}
