import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../domain/modelCallUsageContext.js";
import { normalizeLlmClassifierLanguageLabel } from "../domain/llmClassifierFields.js";
import type { ModelInferencePipeline } from "../infra/llm/modelInferencePipeline.js";
import type { LlmCapabilityResolveInput } from "../infra/llm/workspaceContext.js";
import { renderPromptTemplate } from "../infra/prompts/promptLoader.js";

export interface ResponseLanguageDetection {
  responseLanguage?: string;
}

export interface ResponseLanguageDetectorInput {
  query: string;
  history: MessageRecord[];
  workspaceContext?: LlmCapabilityResolveInput;
  usageContext?: ModelCallUsageContext;
}

export interface ResponseLanguageDetector {
  detect(input: ResponseLanguageDetectorInput): Promise<ResponseLanguageDetection>;
}

const stripJsonFence = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

const formatConversationContext = (messages: MessageRecord[]): string =>
  messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n");

const fallbackUsageContext = (
  input: ResponseLanguageDetectorInput,
): ModelCallUsageContext => ({
  workspaceId: input.workspaceContext?.workspaceId ?? "unknown",
  requestId: randomUUID(),
  surface: "assistant",
  operation: "response_language_detection",
  attemptKey: "response_language",
});

export const parseResponseLanguageDetection = (raw: string): ResponseLanguageDetection => {
  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as { responseLanguage?: unknown };
    const responseLanguage = normalizeLlmClassifierLanguageLabel(parsed.responseLanguage);
    return responseLanguage ? { responseLanguage } : {};
  } catch {
    return {};
  }
};

export class LlmResponseLanguageDetector implements ResponseLanguageDetector {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async detect(input: ResponseLanguageDetectorInput): Promise<ResponseLanguageDetection> {
    if (!input.query.trim() && input.history.length === 0) {
      return {};
    }

    const { text } = await this.inference.complete({
      operation: input.usageContext ?? fallbackUsageContext(input),
      prompt: renderPromptTemplate("chat/detect-response-language.md", {
        context_section: formatConversationContext(input.history) || "No prior context",
        query: input.query,
      }),
      reasoningEffort: CHAT_BEHAVIOR.intentRouting.reasoningEffort,
      maxOutputTokens: 128,
    });

    return parseResponseLanguageDetection(text);
  }
}
