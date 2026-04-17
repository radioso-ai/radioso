import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { isProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
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

const buildUnsupportedWithContextFallback = (input: {
  contexts: GroundedMissContextSummary[];
}): string => {
  const firstTitle = normalizeContexts(input.contexts).find((context) => context.title.length > 0)?.title;
  return renderPromptTemplate("chat/unsupported-with-context-fallback.md", {
    related_title_clause: firstTitle ? ` in "${firstTitle}"` : "",
  });
};

const buildNoContextFallback = (): string =>
  loadPromptTemplate("chat/no-context-fallback.md");

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
  const promptName = input.brevityOverrideRequested
    ? input.hasRetrievedContexts
      ? "chat/grounded-miss/guidance-brief-with-context.md"
      : "chat/grounded-miss/guidance-brief-no-context.md"
    : input.conversationMode === "factual"
      ? input.hasRetrievedContexts
        ? "chat/grounded-miss/guidance-factual-with-context.md"
        : "chat/grounded-miss/guidance-factual-no-context.md"
      : input.conversationMode === "exploratory"
        ? input.hasRetrievedContexts
          ? "chat/grounded-miss/guidance-exploratory-with-context.md"
          : "chat/grounded-miss/guidance-exploratory-no-context.md"
        : input.hasRetrievedContexts
          ? "chat/grounded-miss/guidance-guided-with-context.md"
          : "chat/grounded-miss/guidance-guided-no-context.md";

  return loadPromptTemplate(promptName);
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
    try {
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
      if (normalized) {
        return normalized;
      }
    } catch (error) {
      if (isProviderCredentialError(error)) {
        throw error;
      }
      // Fall back to the deterministic refusal below.
    }

    return buildUnsupportedWithContextFallback({
      contexts: input.contexts,
    });
  }

  async composeNoContext(input: {
    query: string;
    conversationMode?: ConversationMode;
    brevityOverrideRequested?: boolean;
  }): Promise<string> {
    try {
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
      if (normalized) {
        return normalized;
      }
    } catch (error) {
      if (isProviderCredentialError(error)) {
        throw error;
      }
      // Fall back to the deterministic refusal below.
    }

    return buildNoContextFallback();
  }
}
