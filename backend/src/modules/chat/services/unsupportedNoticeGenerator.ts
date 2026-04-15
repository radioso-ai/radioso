import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import { DEFAULT_UNSUPPORTED_NOTICE } from "./answerSupportValidationTypes.js";

export interface UnsupportedNoticeGenerator {
  generate(input: {
    query: string;
    unsupportedText: string;
  }): Promise<string>;
}

const UNSUPPORTED_NOTICE_SYSTEM_PROMPT = loadPromptTemplate("chat/unsupported-notice-system.md");

export class DefaultUnsupportedNoticeGenerator implements UnsupportedNoticeGenerator {
  async generate(): Promise<string> {
    return DEFAULT_UNSUPPORTED_NOTICE;
  }
}

export class ModelUnsupportedNoticeGenerator implements UnsupportedNoticeGenerator {
  constructor(private readonly client: TextGenerationClient) {}

  async generate(input: { query: string; unsupportedText: string }): Promise<string> {
    try {
      const raw = await this.client.complete({
        systemPrompt: UNSUPPORTED_NOTICE_SYSTEM_PROMPT,
        prompt: renderPromptTemplate("chat/unsupported-notice-user.md", {
          query: input.query,
          unsupported_text: input.unsupportedText,
        }),
        temperature: 0,
        maxOutputTokens: 80,
      });

      return normalizeUnsupportedNotice(raw);
    } catch {
      return DEFAULT_UNSUPPORTED_NOTICE;
    }
  }
}

const normalizeUnsupportedNotice = (value: string | undefined): string => {
  const normalized = (value ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ");

  if (!normalized || normalized.length > 240) {
    return DEFAULT_UNSUPPORTED_NOTICE;
  }

  return normalized;
};
