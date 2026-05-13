import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { CHAT_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { loadPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { isProviderCredentialError } from "../../../shared/infra/llm/providerErrors.js";
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
    userExpectedLocale?: string | null;
    answerInstructionBlock?: string;
  }): Promise<string>;
  composeNoContext(input: {
    query: string;
    userExpectedLocale?: string | null;
    answerInstructionBlock?: string;
  }): Promise<string>;
}

export class MissingGroundedMissResponseComposer implements GroundedMissResponseComposer {
  async composeUnsupportedWithContext(_input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
    userExpectedLocale?: string | null;
    answerInstructionBlock?: string;
  }): Promise<string> {
    return buildUnsupportedWithContextFallback(_input.contexts);
  }

  async composeNoContext(_input: {
    query: string;
    userExpectedLocale?: string | null;
    answerInstructionBlock?: string;
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

let groundedMissTemplate: string | undefined;

const getGroundedMissTemplate = (): string => {
  groundedMissTemplate ??= loadPromptTemplate("chat/grounded-miss.md");
  return groundedMissTemplate;
};

const getGroundedMissPromptSection = (sectionName: string): string => {
  const sectionPattern = new RegExp(`--- ${sectionName} ---\\n([\\s\\S]*?)(?=\\n--- [a-z_]+ ---|$)`);
  const match = getGroundedMissTemplate().match(sectionPattern);
  if (!match?.[1]?.trim()) {
    throw new Error(`Missing grounded miss prompt section "${sectionName}"`);
  }

  return match[1].trimEnd();
};

const renderGroundedMissSection = (
  sectionName: string,
  variables: Record<string, string>,
): string => {
  const template = getGroundedMissPromptSection(sectionName);

  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, key: string) => {
    if (!(key in variables)) {
      throw new Error(`Missing prompt variable "${key}" for grounded miss section ${sectionName}`);
    }

    return variables[key] ?? "";
  });
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

const buildLocaleInstruction = (userExpectedLocale?: string | null): string => {
  const locale = resolveChatLocale({ userExpectedLocale });
  return locale
    ? `Write the response in locale ${locale}. If the wording is ambiguous, prefer that locale over inferred query language.`
    : "Write the response in the same language as the user's question.";
};

const buildAnswerInstructionBlock = (answerInstructionBlock?: string): string => {
  const normalized = normalizeWhitespace(answerInstructionBlock);
  return normalized.length > 0 ? normalized : "No additional answer instructions.";
};

const buildNoContextFallback = (): string => renderGroundedMissSection("fallback_no_context", {});

const buildUnsupportedWithContextFallback = (contexts: GroundedMissContextSummary[]): string => {
  const titledContext = normalizeContexts(contexts).find((context) => context.title.length > 0);

  if (!titledContext) {
    return renderGroundedMissSection("fallback_unsupported_with_context_untitled", {});
  }

  return renderGroundedMissSection("fallback_unsupported_with_context", {
    title: titledContext.title,
  });
};

export class ModelGroundedMissResponseComposer implements GroundedMissResponseComposer {
  constructor(private readonly client: TextGenerationClient) {}

  private async completeWithRetry(request: {
    prompt: string;
    systemPrompt?: string;
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
    userExpectedLocale?: string | null;
    answerInstructionBlock?: string;
  }): Promise<string> {
    try {
      const raw = await this.completeWithRetry({
        prompt: renderGroundedMissSection("prompt", {
          miss_kind: "unsupported_with_context",
          locale_instruction: buildLocaleInstruction(input.userExpectedLocale),
          query: input.query,
          answer_instruction_block: buildAnswerInstructionBlock(input.answerInstructionBlock),
          has_retrieved_contexts: "yes",
          unsupported_text: input.unsupportedText.trim(),
          contexts_section: formatContextsForPrompt(input.contexts),
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
    userExpectedLocale?: string | null;
    answerInstructionBlock?: string;
  }): Promise<string> {
    try {
      const raw = await this.completeWithRetry({
        prompt: renderGroundedMissSection("prompt", {
          miss_kind: "no_context",
          locale_instruction: buildLocaleInstruction(input.userExpectedLocale),
          query: input.query,
          answer_instruction_block: buildAnswerInstructionBlock(input.answerInstructionBlock),
          has_retrieved_contexts: "no",
          unsupported_text: "None",
          contexts_section: "None",
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
