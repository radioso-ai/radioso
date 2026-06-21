import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../domain/modelCallUsageContext.js";
import type { ModelInferencePipeline } from "../infra/llm/modelInferencePipeline.js";
import type { LlmCapabilityResolveInput } from "../infra/llm/workspaceContext.js";
import { renderPromptTemplate } from "../infra/prompts/promptLoader.js";

export interface HandoffWaitingMessageInput {
  query: string;
  history: MessageRecord[];
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext?: ModelCallUsageContext;
}

export interface HandoffWaitingMessageGenerator {
  // Returns a short, conversation-language "a teammate is joining, please wait" line,
  // or "" when no message could be generated (the caller renders nothing in that case).
  generate(input: HandoffWaitingMessageInput): Promise<string>;
}

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

const fallbackUsageContext = (
  input: HandoffWaitingMessageInput,
): ModelCallUsageContext => ({
  workspaceId: input.workspaceContext?.workspaceId ?? "unknown",
  requestId: randomUUID(),
  surface: "assistant",
  operation: "handoff_waiting_message",
  attemptKey: "handoff_waiting",
});

export class LlmHandoffWaitingMessageGenerator implements HandoffWaitingMessageGenerator {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async generate(input: HandoffWaitingMessageInput): Promise<string> {
    const { text } = await this.inference.complete({
      operation: input.usageContext ?? fallbackUsageContext(input),
      prompt: renderPromptTemplate("chat/handoff-waiting-message.md", {
        context_section: formatConversationContext(input.history) || "No prior context",
        query: input.query,
      }),
      reasoningEffort: CHAT_BEHAVIOR.intentRouting.reasoningEffort,
      maxOutputTokens: 128,
    });

    return text.trim();
  }
}
