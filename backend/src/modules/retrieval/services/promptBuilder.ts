import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { type Clock, formatPromptDateUtc, systemClock } from "../../../shared/domain/clock.js";
import { loadPromptTemplate, renderPromptTemplate } from "../../../shared/infra/prompts/promptLoader.js";
import type { ResponseIdentity } from "../../../shared/domain/responseIdentity.js";
import type { FinalPromptContext, ResponseLanguagePolicy } from "../domain/retrievalPipelineTypes.js";
import {
  type DatedItemRelation,
  datesFromMetadata,
  relationToDateRange,
  type RequestedDateRange,
} from "../domain/temporal/requestedDateRange.js";
import { resolveContextSourceUrl } from "./contextSourceUrl.js";
import { renderMetadataPromptText } from "./searchTextRenderer.js";
import { SharedAnswerInstructionBuilder } from "./sharedAnswerInstructionBuilder.js";

export interface PromptBuildResult {
  systemPrompt: string;
  prompt: string;
  citations: Array<{ documentId: string; chunkId: string; title: string }>;
}

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
    /** The period the question asks about, when the rewrite resolved one. */
    requestedDateRange?: RequestedDateRange;
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
        // Sanitize to prevent prompt injection via newlines or control characters.
        const rawSourceUrl = resolveContextSourceUrl(context.metadata) ?? "";
        const sanitizedSourceUrl = rawSourceUrl.replace(/[\n\r\t\x00-\x1f]/g, "").slice(0, 2048);
        const rawMetadataText = renderMetadataPromptText(context.metadata ?? {});
        const sanitizedMetadataText = rawMetadataText
          .replace(/[\n\r\t\x00-\x1f]/g, " ")
          .slice(0, 2048);
        const metadataLines = [
          sanitizedSourceUrl ? `Source: ${sanitizedSourceUrl}` : "",
          sanitizedMetadataText ? `Attributes: ${sanitizedMetadataText}` : "",
          input.requestedDateRange ? periodRelationLine(context.metadata, input.requestedDateRange) : "",
        ].filter((line) => line.length > 0);
        const metadataSection = metadataLines.length > 0 ? `${metadataLines.join("\n")}\n` : "";
        return `Result ${index + 1} (${context.title}): ${metadataSection}${context.content}`;
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
        today: formatPromptDateUtc(this.clock()),
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
        // Per-turn, so it renders in the request and leaves the standing instructions, and
        // their reusable prefix, unchanged.
        requested_period_section: input.requestedDateRange
          ? `${renderPromptTemplate("retrieval/answer-requested-period.md", {
              period: formatDateSpan(input.requestedDateRange),
            })}

`
          : "",
      }),
      citations: input.contexts.map((context) => ({
        documentId: context.documentId,
        chunkId: context.chunkId,
        title: context.title,
      })),
    };
  }
}

// "2026-10-24 (Saturday) to 2026-10-25 (Sunday)", or the one day for a single-day span.
const formatDateSpan = (span: { dateFrom: string; dateTo: string }): string => {
  const day = (date: string) => formatPromptDateUtc(new Date(`${date}T00:00:00.000Z`));
  return span.dateFrom === span.dateTo ? day(span.dateFrom) : `${day(span.dateFrom)} to ${day(span.dateTo)}`;
};

const dayCount = (days: number): string => (days === 1 ? "1 day" : `${days} days`);

// English facts for the model, which answers in the visitor's language. The requested-period
// instructions name the "Period relation" label, so the two change together.
const describeRelation = ({ span, relation }: DatedItemRelation): string => {
  switch (relation.kind) {
    case "entirely_before":
      return `entirely before the requested period, ending ${dayCount(relation.endsDaysBefore)} before it begins`;
    case "entirely_after":
      return `entirely after the requested period, beginning ${dayCount(relation.beginsDaysAfter)} after it ends`;
    case "inside":
      return span.dateFrom === span.dateTo ? "inside the requested period" : "begins and ends inside the requested period";
    case "begins_before_ends_inside":
      return `begins ${dayCount(relation.beginsDaysBefore)} before the requested period and ends inside it`;
    case "begins_inside_ends_after":
      return `begins inside the requested period and ends ${dayCount(relation.endsDaysAfter)} after it`;
    case "spans_range":
      return `begins ${dayCount(relation.beginsDaysBefore)} before the requested period and ends ${dayCount(relation.endsDaysAfter)} after it, covering all of it`;
  }
};

/**
 * How a dated excerpt sits against the requested period, computed so the answer transcribes the
 * relation instead of comparing dates itself. Empty for an excerpt without calendar dates.
 */
const periodRelationLine = (metadata: Record<string, unknown> | undefined, range: RequestedDateRange): string => {
  const related = relationToDateRange(datesFromMetadata(metadata), range);
  return related ? `Period relation: dated ${formatDateSpan(related.span)}; ${describeRelation(related)}` : "";
};
