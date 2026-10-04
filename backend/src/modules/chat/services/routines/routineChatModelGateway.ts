import type {
  ConversationMessage,
  ConversationModelGateway,
} from "@radioso/conversation-contract";

import type { ChatGateway, ChatGatewayInput, ChatGatewayUsageContext } from "../../contracts/chatGateway.js";
import { isBlankChatAnswerError } from "../chatAnswerErrors.js";
import { CHAT_BEHAVIOR } from "../../../../shared/domain/behaviorConfig.js";
import type { LlmCapabilityResolveInput } from "../../../../shared/infra/llm/workspaceContext.js";

/** The per-turn billing + model-resolution context a routine LLM call needs. */
interface RoutineModelTurnContext {
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
    if (messages[index].role === "user") {
      return messages[index].content;
    }
  }
  return "";
};

const isRoutineActivationCall = (metadata: Record<string, unknown> | undefined): boolean =>
  metadata?.routineActivation === true;

const routineActivationUsageContext = (usageContext: ChatGatewayUsageContext): ChatGatewayUsageContext => ({
  ...usageContext,
  operation: "routine_activation",
  attemptKey: `${usageContext.attemptKey}:routine_activation`,
});

/**
 * `usage_events.idempotency_key` is unique, and it is built from `attemptKey` among other
 * fields, so every call in a turn sharing one attemptKey means only the first survives
 * `ON CONFLICT DO NOTHING` (#1378). The first call keeps the turn's attemptKey unchanged —
 * single-call turns and existing dashboards are unaffected — and each later call gets its
 * own, ordered by call order.
 */
const withCallOrdinal = (usageContext: ChatGatewayUsageContext, ordinal: number): ChatGatewayUsageContext =>
  ordinal === 1 ? usageContext : { ...usageContext, attemptKey: `${usageContext.attemptKey}:${ordinal}` };

/**
 * Adapts the host {@link ChatGateway} to the engine's {@link ConversationModelGateway}
 * for routine progression. Built per turn (it carries that turn's usage + workspace
 * context, which are not on the engine's `TurnContext`), it lets the routine next-step
 * selector and step renderer generate through the same workspace/usage-accounted model
 * as normal chat answers. Generation stays LLM-owned; this only bridges the shapes.
 */
export class RoutineChatModelGateway implements ConversationModelGateway {
  // Assigned in call order, at call start, so the ordinal is deterministic regardless of
  // when each call settles.
  private callCount = 0;

  constructor(
    private readonly chatGateway: Pick<ChatGateway, "answer">,
    private readonly turn: RoutineModelTurnContext,
  ) {}

  async complete(input: {
    messages: ConversationMessage[];
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ text: string }> {
    this.callCount += 1;
    const ordinal = this.callCount;
    const routineActivation = isRoutineActivationCall(input.metadata);
    const baseUsageContext = routineActivation
      ? routineActivationUsageContext(this.turn.usageContext)
      : this.turn.usageContext;
    const request: ChatGatewayInput = {
      query: lastUserContent(input.messages),
      history: [],
      prompt: serializeTranscript(input.messages),
      systemPrompt: input.systemPrompt,
      workspaceContext: this.turn.workspaceContext,
      usageContext: withCallOrdinal(baseUsageContext, ordinal),
      ...(routineActivation ? { generation: CHAT_BEHAVIOR.intentRouting } : {}),
      ...(this.turn.signal ? { signal: this.turn.signal } : {}),
    };
    try {
      return { text: await this.chatGateway.answer(request) };
    } catch (error) {
      // The model occasionally returns an empty completion for a routine prompt, and one
      // blank call used to fail the whole turn. Retry once, under its own usage attempt so
      // the failed call and the retry are both accounted for.
      if (!isBlankChatAnswerError(error)) {
        throw error;
      }
      const retryUsage = { ...request.usageContext, attemptKey: `${request.usageContext.attemptKey}:blank_retry` };
      return { text: await this.chatGateway.answer({ ...request, usageContext: retryUsage }) };
    }
  }
}
