import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";

export interface GroundedMissContextSummary {
  title: string;
  content: string;
}

export interface GroundedMissResponseComposer {
  composeUnsupportedWithContext(input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
    conversationMode?: ConversationMode;
    brevityOverrideRequested?: boolean;
  }): Promise<string>;
  composeNoContext(input: {
    query: string;
    conversationMode?: ConversationMode;
    brevityOverrideRequested?: boolean;
  }): Promise<string>;
}

export class MissingGroundedMissResponseComposer implements GroundedMissResponseComposer {
  async composeUnsupportedWithContext(_input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
    conversationMode?: ConversationMode;
    brevityOverrideRequested?: boolean;
  }): Promise<string> {
    throw new Error("grounded_miss_response_composer_not_configured");
  }

  async composeNoContext(_input: {
    query: string;
    conversationMode?: ConversationMode;
    brevityOverrideRequested?: boolean;
  }): Promise<string> {
    throw new Error("grounded_miss_response_composer_not_configured");
  }
}

const MAX_TITLE_LENGTH = CHAT_BEHAVIOR.groundedMiss.maxTitleLength;
const MAX_CONTEXT_LENGTH = CHAT_BEHAVIOR.groundedMiss.maxContextLength;
const MAX_CONTEXTS = CHAT_BEHAVIOR.groundedMiss.maxContexts;
const MAX_RESPONSE_LENGTH = CHAT_BEHAVIOR.groundedMiss.maxResponseLength;

const normalizeWhitespace = (value: string | undefined): string =>
  (value ?? "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const limit = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;

const normalizeContexts = (contexts: GroundedMissContextSummary[]) =>
  contexts
    .slice(0, MAX_CONTEXTS)
    .map((context) => ({
      title: limit(normalizeWhitespace(context.title), MAX_TITLE_LENGTH),
      content: limit(normalizeWhitespace(context.content), MAX_CONTEXT_LENGTH),
    }))
    .filter((context) => context.title.length > 0 || context.content.length > 0);

const formatContextsForPrompt = (contexts: GroundedMissContextSummary[]): string => {
  const normalized = normalizeContexts(contexts);
  if (normalized.length === 0) {
    return "None";
  }

  return normalized
    .map((context, index) => [
      `Context ${index + 1}:`,
      context.title ? `Title: ${context.title}` : "Title: (untitled)",
      context.content ? `Excerpt: ${context.content}` : "Excerpt: (empty)",
    ].join("\n"))
    .join("\n\n");
};

const normalizeModelResponse = (value: string | undefined): string => {
  const normalized = normalizeWhitespace(value)
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1");

  if (!normalized || normalized.length > MAX_RESPONSE_LENGTH) {
    return "";
  }

  return normalized;
};

const buildConversationModeGuidance = (input: {
  conversationMode?: ConversationMode;
  brevityOverrideRequested?: boolean;
  hasRetrievedContexts: boolean;
}): string => {
  if (input.brevityOverrideRequested) {
    return [
      "The user explicitly requested a brief answer.",
      "Keep the response direct and concise.",
      input.hasRetrievedContexts
        ? "Do not add optional adjacent directions unless they are necessary to honestly orient the user."
        : "At most, offer one concise next-step hint for how the user could search more narrowly.",
    ].join("\n");
  }

  switch (input.conversationMode ?? "guided") {
    case "factual":
      return input.hasRetrievedContexts
        ? [
            "Conversation mode: factual.",
            "State the grounded limitation directly.",
            "Do not add optional adjacent directions beyond the minimum honest orientation.",
          ].join("\n")
        : [
            "Conversation mode: factual.",
            "State that relevant material was not found.",
            "Do not add optional exploration beyond a minimal direct next step if needed.",
          ].join("\n");
    case "exploratory":
      return input.hasRetrievedContexts
        ? [
            "Conversation mode: exploratory.",
            "After the direct limitation, you may mention two or three grounded adjacent directions supported by the retrieved contexts.",
            "Keep any optional continuation clearly separated from the direct limitation.",
          ].join("\n")
        : [
            "Conversation mode: exploratory.",
            "After the direct limitation, you may suggest two or three concise ways to search more narrowly within the workspace.",
            "Keep any optional continuation clearly separated from the direct limitation.",
          ].join("\n");
    case "guided":
    default:
      return input.hasRetrievedContexts
        ? [
            "Conversation mode: guided.",
            "After the direct limitation, you may mention one or two grounded adjacent directions supported by the retrieved contexts.",
            "Keep any optional continuation concise and clearly separated from the direct limitation.",
          ].join("\n")
        : [
            "Conversation mode: guided.",
            "After the direct limitation, you may offer one concise next-step hint for searching within the workspace.",
            "Keep any optional continuation concise and clearly separated from the direct limitation.",
          ].join("\n");
  }
};

const NO_CONTEXT_SYSTEM_PROMPT = loadPromptTemplate("chat/no-context-system.md");
const UNSUPPORTED_WITH_CONTEXT_SYSTEM_PROMPT = loadPromptTemplate("chat/unsupported-with-context-system.md");

export class ModelGroundedMissResponseComposer implements GroundedMissResponseComposer {
  constructor(private readonly client: TextGenerationClient) {}

  private async completeWithRetry(request: {
    systemPrompt: string;
    prompt: string;
    temperature: number;
    maxOutputTokens: number;
  }): Promise<string | undefined> {
    try {
      return await this.client.complete(request);
    } catch {
      return this.client.complete(request);
    }
  }

  async composeUnsupportedWithContext(input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
    conversationMode?: ConversationMode;
    brevityOverrideRequested?: boolean;
  }): Promise<string> {
    const raw = await this.completeWithRetry({
      systemPrompt: UNSUPPORTED_WITH_CONTEXT_SYSTEM_PROMPT,
      prompt: renderPromptTemplate("chat/unsupported-with-context-user.md", {
        query: input.query,
        unsupported_text: normalizeWhitespace(input.unsupportedText),
        contexts_section: formatContextsForPrompt(input.contexts),
        conversation_mode_guidance: buildConversationModeGuidance({
          conversationMode: input.conversationMode,
          brevityOverrideRequested: input.brevityOverrideRequested,
          hasRetrievedContexts: true,
        }),
      }),
      temperature: CHAT_BEHAVIOR.groundedMiss.temperature,
      maxOutputTokens: CHAT_BEHAVIOR.groundedMiss.unsupportedWithContextMaxOutputTokens,
    });

    const normalized = normalizeModelResponse(raw);
    if (!normalized) {
      throw new Error("grounded_miss_with_context_generation_failed");
    }

    return normalized;
  }

  async composeNoContext(input: {
    query: string;
    conversationMode?: ConversationMode;
    brevityOverrideRequested?: boolean;
  }): Promise<string> {
    const raw = await this.completeWithRetry({
      systemPrompt: NO_CONTEXT_SYSTEM_PROMPT,
      prompt: renderPromptTemplate("chat/no-context-user.md", {
        query: input.query,
        conversation_mode_guidance: buildConversationModeGuidance({
          conversationMode: input.conversationMode,
          brevityOverrideRequested: input.brevityOverrideRequested,
          hasRetrievedContexts: false,
        }),
      }),
      temperature: CHAT_BEHAVIOR.groundedMiss.temperature,
      maxOutputTokens: CHAT_BEHAVIOR.groundedMiss.noContextMaxOutputTokens,
    });

    const normalized = normalizeModelResponse(raw);
    if (!normalized) {
      throw new Error("no_context_generation_failed");
    }

    return normalized;
  }
}
