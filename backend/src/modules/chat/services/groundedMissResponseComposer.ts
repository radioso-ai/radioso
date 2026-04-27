import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { isProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";
import { resolveChatLocale } from "./chatLocale.js";

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
    userExpectedLocale?: string | null;
  }): Promise<string>;
  composeNoContext(input: {
    query: string;
    conversationMode?: ConversationMode;
    userExpectedLocale?: string | null;
  }): Promise<string>;
}

export class MissingGroundedMissResponseComposer implements GroundedMissResponseComposer {
  async composeUnsupportedWithContext(_input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
    conversationMode?: ConversationMode;
    userExpectedLocale?: string | null;
  }): Promise<string> {
    return buildUnsupportedWithContextFallback(_input.contexts);
  }

  async composeNoContext(_input: {
    query: string;
    conversationMode?: ConversationMode;
    userExpectedLocale?: string | null;
  }): Promise<string> {
    return buildNoContextFallback();
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

// Keep model-authored markdown structure, but strip citation artifacts and noisy spacing
// before the fallback response is shown to users.
const normalizeModelResponse = (value: string | undefined): string => {
  const normalized = (value ?? "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\[\[[^\]]*\]\]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();

  if (!normalized || normalized.length > MAX_RESPONSE_LENGTH) {
    return "";
  }

  return normalized;
};

const buildConversationModeGuidance = (input: {
  conversationMode?: ConversationMode;
  hasRetrievedContexts: boolean;
}): string => {
  return renderPromptTemplate("chat/grounded-miss/conversation-mode-guidance.md", {
    conversation_mode: input.conversationMode ?? "guided",
    has_retrieved_contexts: input.hasRetrievedContexts ? "yes" : "no",
  });
};

const buildLocaleInstruction = (userExpectedLocale?: string | null): string => {
  const locale = resolveChatLocale({ userExpectedLocale });
  return locale
    ? `Write the response in locale ${locale}. If the wording is ambiguous, prefer that locale over inferred query language.`
    : "Write the response in the same language as the user's question.";
};

const NO_CONTEXT_FALLBACK_PROMPT = loadPromptTemplate("chat/grounded-miss/fallback-no-context.md");

const buildNoContextFallback = (): string => NO_CONTEXT_FALLBACK_PROMPT;

const buildUnsupportedWithContextFallback = (contexts: GroundedMissContextSummary[]): string => {
  const titledContext = normalizeContexts(contexts).find((context) => context.title.length > 0);

  if (!titledContext) {
    return loadPromptTemplate("chat/grounded-miss/fallback-unsupported-with-context-untitled.md");
  }

  return renderPromptTemplate("chat/grounded-miss/fallback-unsupported-with-context.md", {
    title: titledContext.title,
  });
};

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
    userExpectedLocale?: string | null;
  }): Promise<string> {
    try {
      const raw = await this.completeWithRetry({
        systemPrompt: `${renderPromptTemplate("chat/grounded-miss/system.md", {
          miss_kind: "unsupported_with_context",
        })}\n${buildLocaleInstruction(input.userExpectedLocale)}`,
        prompt: renderPromptTemplate("chat/grounded-miss/user.md", {
          miss_kind: "unsupported_with_context",
          query: input.query,
          unsupported_text: input.unsupportedText.trim(),
          contexts_section: formatContextsForPrompt(input.contexts),
          conversation_mode_guidance: buildConversationModeGuidance({
            conversationMode: input.conversationMode,
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

      return buildUnsupportedWithContextFallback(input.contexts);
    } catch (error) {
      if (isProviderCredentialError(error)) {
        throw error;
      }

      return buildUnsupportedWithContextFallback(input.contexts);
    }
  }

  async composeNoContext(input: {
    query: string;
    conversationMode?: ConversationMode;
    userExpectedLocale?: string | null;
  }): Promise<string> {
    try {
      const raw = await this.completeWithRetry({
        systemPrompt: `${renderPromptTemplate("chat/grounded-miss/system.md", {
          miss_kind: "no_context",
        })}\n${buildLocaleInstruction(input.userExpectedLocale)}`,
        prompt: renderPromptTemplate("chat/grounded-miss/user.md", {
          miss_kind: "no_context",
          query: input.query,
          unsupported_text: "None",
          contexts_section: "None",
          conversation_mode_guidance: buildConversationModeGuidance({
            conversationMode: input.conversationMode,
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

      return buildNoContextFallback();
    } catch (error) {
      if (isProviderCredentialError(error)) {
        throw error;
      }

      return buildNoContextFallback();
    }
  }
}
