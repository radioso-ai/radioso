import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { type Clock, formatIsoDateUtc, systemClock } from "../../../shared/domain/clock.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { FinalPromptContext, ResponseLanguagePolicy } from "../domain/retrievalPipelineTypes.js";
import { resolveContextSourceUrl } from "./contextSourceUrl.js";
import { SharedAnswerInstructionBuilder } from "./sharedAnswerInstructionBuilder.js";

export interface PromptBuildResult {
  systemPrompt: string;
  prompt: string;
  citations: Array<{ documentId: string; chunkId: string; title: string }>;
}

const CONTROL_CHARACTER_PATTERN = /[\n\r\t\x00-\x1f]/;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?$/;

const boundedContextMetadataText = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || CONTROL_CHARACTER_PATTERN.test(normalized)) {
    return null;
  }
  return normalized.slice(0, maxLength);
};

const contextMetadataLines = (metadata: Record<string, unknown> | undefined): string[] => {
  const sourceUrl = (resolveContextSourceUrl(metadata) ?? "")
    .replace(/[\n\r\t\x00-\x1f]/g, "")
    .slice(0, 2048);
  const author = boundedContextMetadataText(metadata?.author, 256);
  const publishedAt = boundedContextMetadataText(metadata?.published_at, 64);

  return [
    sourceUrl ? `Source: ${sourceUrl}` : "",
    author ? `Author: ${author}` : "",
    publishedAt && ISO_TIMESTAMP_PATTERN.test(publishedAt) ? `Published: ${publishedAt}` : "",
  ].filter((line) => line.length > 0);
};

export class PromptBuilder {
  constructor(
    private readonly sharedAnswerInstructionBuilder = new SharedAnswerInstructionBuilder(),
    private readonly clock: Clock = systemClock,
  ) {}

  build(input: {
    query: string;
    retrievalQuery?: string;
    history: MessageRecord[];
    contexts: FinalPromptContext[];
    settings: {
      responseIdentity?: ResponseIdentity | null;
      customInstruction?: string;
      responseLanguagePolicy?: ResponseLanguagePolicy;
      responseLanguage?: string;
    };
  }): PromptBuildResult {
    const historySection = input.history
      .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
      .join("\n");
    const contextsSection = input.contexts
      .map((context, index) => {
        // Metadata is line-delimited prompt context, so reject control characters
        // and bound every projected value before placing it beside source content.
        const metadataLines = contextMetadataLines(context.metadata);
        const metadataBlock = metadataLines.length > 0 ? `${metadataLines.join("\n")}\n` : "";
        return `Result ${index + 1} (${context.title}): ${metadataBlock}${context.content}`;
      })
      .join("\n\n");
    const answerInstructionBlocks = this.sharedAnswerInstructionBuilder.build({
      responseIdentity: input.settings.responseIdentity,
      customInstruction: input.settings.customInstruction,
      responseLanguagePolicy: input.settings.responseLanguagePolicy,
      responseLanguage: input.settings.responseLanguage,
    });

    return {
      systemPrompt: renderPromptTemplate("retrieval/answer.md", {
        response_identity_block: answerInstructionBlocks.responseIdentityBlock
          ? `${answerInstructionBlocks.responseIdentityBlock}\n`
          : "",
        custom_instruction_block: answerInstructionBlocks.customInstructionBlock
          ? `${answerInstructionBlocks.customInstructionBlock}\n`
          : "",
        conversation_mode_instruction_block: "",
        response_language_instruction: answerInstructionBlocks.responseLanguageInstruction,
        today: formatIsoDateUtc(this.clock()),
        // The grounded answer prompt answers or declines inline; it carries only the
        // compact guard-case essentials. The full decline ruleset stays scoped to the
        // dedicated focused-miss path (#863 split-by-turn-type).
        decline_rules: loadPromptTemplate("chat/grounded-inline-decline.md"),
      }),
      prompt: renderPromptTemplate("retrieval/answer-user.md", {
        history_section: historySection || "No prior history",
        contexts_section: contextsSection || "No retrieved context",
        original_query: input.query,
        query: input.query,
        retrieval_query: input.retrievalQuery ?? input.query,
      }),
      citations: input.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
      })),
    };
  }
}
