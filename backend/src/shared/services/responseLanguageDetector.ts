import { randomUUID } from "node:crypto";

import type { MessageRecord } from "../../db/repositories/messageRepository.js";
import { CHAT_BEHAVIOR } from "../domain/behaviorConfig.js";
import type { ModelCallUsageContext } from "../domain/modelCallUsageContext.js";
import { normalizeLlmClassifierLanguageLabel } from "../domain/llmClassifierFields.js";
import type { ModelInferencePipeline } from "../infra/llm/modelInferencePipeline.js";
import type { LlmCapabilityResolveInput } from "../infra/llm/workspaceContext.js";
import { renderPromptTemplate } from "../infra/prompts/promptLoader.js";

/**
 * Why a detection produced no label. `no_input` and `no_label` are honest outcomes
 * (nothing to judge, or the model found no reliable language); `unparseable_output`
 * and `rejected_label` mean the model broke its output contract. Structural only —
 * never the query, the history, or the raw model output.
 */
export type ResponseLanguageUnresolvedReason =
  | "no_input"
  | "no_label"
  | "unparseable_output"
  | "rejected_label";

export interface ResponseLanguageDetection {
  responseLanguage?: string;
  /** Set exactly when `responseLanguage` is absent. */
  unresolvedReason?: ResponseLanguageUnresolvedReason;
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

const parseDetectionJson = (raw: string): { responseLanguage?: unknown } | null => {
  try {
    const parsed: unknown = JSON.parse(stripJsonFence(raw));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const parseResponseLanguageDetection = (raw: string): ResponseLanguageDetection => {
  const parsed = parseDetectionJson(raw);
  if (!parsed) {
    return { unresolvedReason: "unparseable_output" };
  }
  const label = parsed.responseLanguage;
  if (label === undefined || label === null || (typeof label === "string" && label.trim().length === 0)) {
    return { unresolvedReason: "no_label" };
  }
  const responseLanguage = normalizeLlmClassifierLanguageLabel(label);
  return responseLanguage ? { responseLanguage } : { unresolvedReason: "rejected_label" };
};

export class LlmResponseLanguageDetector implements ResponseLanguageDetector {
  constructor(private readonly inference: ModelInferencePipeline) {}

  async detect(input: ResponseLanguageDetectorInput): Promise<ResponseLanguageDetection> {
    if (!input.query.trim() && input.history.length === 0) {
      return { unresolvedReason: "no_input" };
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
