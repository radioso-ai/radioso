import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";

export interface GroundedMissContextSummary {
  title: string;
  content: string;
}

export interface GroundedMissResponseComposer {
  composeUnsupportedWithContext(input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
  }): Promise<string>;
  composeNoContext(input: {
    query: string;
  }): Promise<string>;
}

export const DEFAULT_NO_CONTEXT_RESPONSE =
  "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.";

export const DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE =
  "I couldn't verify that from your workspace documents, but I did find related material if you'd like to explore that instead.";

const DEFAULT_UNSUPPORTED_PREFIX = "I couldn't verify that from your workspace documents";
const MAX_TITLE_LENGTH = 120;
const MAX_CONTEXT_LENGTH = 180;
const MAX_CONTEXTS = 3;
const MAX_RESPONSE_LENGTH = 320;

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

const selectPrimaryTitle = (contexts: GroundedMissContextSummary[]): string | null =>
  normalizeContexts(contexts).find((context) => context.title.length > 0)?.title ?? null;

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

const defaultUnsupportedResponse = (contexts: GroundedMissContextSummary[]): string => {
  const title = selectPrimaryTitle(contexts);

  if (!title) {
    return DEFAULT_UNSUPPORTED_WITHOUT_CONTEXT_RESPONSE;
  }

  return `${DEFAULT_UNSUPPORTED_PREFIX}, but I did find related material in "${title}" if you'd like to explore that instead.`;
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

const NO_CONTEXT_SYSTEM_PROMPT = loadPromptTemplate("chat/no-context-system.md");
const UNSUPPORTED_WITH_CONTEXT_SYSTEM_PROMPT = loadPromptTemplate("chat/unsupported-with-context-system.md");

export class DefaultGroundedMissResponseComposer implements GroundedMissResponseComposer {
  async composeUnsupportedWithContext(input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
  }): Promise<string> {
    void input.query;
    void input.unsupportedText;
    return defaultUnsupportedResponse(input.contexts);
  }

  async composeNoContext(): Promise<string> {
    return DEFAULT_NO_CONTEXT_RESPONSE;
  }
}

export class ModelGroundedMissResponseComposer implements GroundedMissResponseComposer {
  constructor(private readonly client: TextGenerationClient) {}

  async composeUnsupportedWithContext(input: {
    query: string;
    unsupportedText: string;
    contexts: GroundedMissContextSummary[];
  }): Promise<string> {
    const fallback = defaultUnsupportedResponse(input.contexts);

    try {
      const raw = await this.client.complete({
        systemPrompt: UNSUPPORTED_WITH_CONTEXT_SYSTEM_PROMPT,
        prompt: renderPromptTemplate("chat/unsupported-with-context-user.md", {
          query: input.query,
          unsupported_text: normalizeWhitespace(input.unsupportedText),
          contexts_section: formatContextsForPrompt(input.contexts),
        }),
        temperature: 0,
        maxOutputTokens: 120,
      });

      return normalizeModelResponse(raw) || fallback;
    } catch {
      return fallback;
    }
  }

  async composeNoContext(input: { query: string }): Promise<string> {
    try {
      const raw = await this.client.complete({
        systemPrompt: NO_CONTEXT_SYSTEM_PROMPT,
        prompt: renderPromptTemplate("chat/no-context-user.md", {
          query: input.query,
        }),
        temperature: 0,
        maxOutputTokens: 80,
      });

      return normalizeModelResponse(raw) || DEFAULT_NO_CONTEXT_RESPONSE;
    } catch {
      return DEFAULT_NO_CONTEXT_RESPONSE;
    }
  }
}
