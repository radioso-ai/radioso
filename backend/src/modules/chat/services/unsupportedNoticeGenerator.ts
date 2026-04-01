import type { TextGenerationClient } from "../../../shared/infra/llm/providerTypes.js";
import { DEFAULT_UNSUPPORTED_NOTICE } from "./answerSupportValidationTypes.js";

export interface UnsupportedNoticeGenerator {
  generate(input: {
    query: string;
    unsupportedText: string;
  }): Promise<string>;
}

const UNSUPPORTED_NOTICE_SYSTEM_PROMPT = `Rewrite unsupported answer content as a short non-verification notice.
Respond in the same language as the user's query when possible.
Do not add any factual content beyond saying the requested claim could not be verified from the retrieved documents.
Do not answer the question.
Keep the notice to one short sentence.
Return plain text only.`;

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
        prompt: `User query:\n${input.query}\n\nUnsupported answer content:\n${input.unsupportedText}`,
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
