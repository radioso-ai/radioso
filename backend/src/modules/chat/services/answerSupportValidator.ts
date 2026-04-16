import type { AnswerSegment, CitationEvidence } from "./answerPresentationService.js";
import type { AnswerSupportPolicy, ConversationMode } from "../../settings/domain/retrievalSettings.js";
import { shouldPreserveUnsupportedSegments, shouldReplaceUnsupportedSegments } from "./answerSupportPolicy.js";
import {
  DEFAULT_UNSUPPORTED_NOTICE,
  type ValidatedAnswer,
  VALIDATION_DISPOSITION,
} from "./answerSupportValidationTypes.js";
import type { GroundedMissResponseComposer } from "./groundedMissResponseComposer.js";
import type { UnsupportedNoticeGenerator } from "./unsupportedNoticeGenerator.js";

const NON_SUBSTANTIVE_PHRASES = new Set([
  "hello",
  "hi",
  "hey",
  "sure",
  "of course",
  "certainly",
  "absolutely",
  "thanks",
  "thank you",
  "glad to help",
  "happy to help",
  "no problem",
  "you are welcome",
  "youre welcome",
  "okay",
  "ok",
]);

const normalizeForMeaningCheck = (value: string): string =>
  value
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();

const isNonSubstantiveText = (value: string): boolean => {
  const normalized = normalizeForMeaningCheck(value);
  if (normalized.length === 0) {
    return true;
  }

  return NON_SUBSTANTIVE_PHRASES.has(normalized);
};

const preservePrefix = (value: string): string => value.match(/^[\s,.;:!?()/-]*/)?.[0] ?? "";
const stripPrefix = (value: string): string => value.replace(/^[\s,.;:!?()/-]*/, "");

const toChatCitation = (citation: CitationEvidence) => ({
  documentId: citation.documentId,
  chunkId: citation.chunkId,
  title: citation.title,
});

export class AnswerSupportValidator {
  async validate(input: {
    query: string;
    answer: string;
    answerSegments: AnswerSegment[];
    citationEvidence: CitationEvidence[];
    retrievedContextSummaries: Array<{ title: string; content: string }>;
    citationDisplayEnabled: boolean;
    answerSupportPolicy: AnswerSupportPolicy;
    conversationMode: ConversationMode;
    brevityOverrideRequested: boolean;
    unsupportedNoticeGenerator: UnsupportedNoticeGenerator;
    groundedMissResponseComposer: GroundedMissResponseComposer;
  }): Promise<ValidatedAnswer> {
    const segmentResults = await Promise.all(input.answerSegments.map(async (segment) => {
      if (isNonSubstantiveText(segment.text)) {
        return {
          originalText: segment.text,
          text: segment.text,
          disposition: VALIDATION_DISPOSITION.NON_SUBSTANTIVE,
          citationIndices: segment.citationIndices,
          replacementApplied: false,
          reason: "non_substantive_text",
        } as const;
      }

      if ((segment.citationIndices?.length ?? 0) > 0) {
        return {
          originalText: segment.text,
          text: segment.text,
          disposition: VALIDATION_DISPOSITION.SUPPORTED,
          citationIndices: segment.citationIndices,
          replacementApplied: false,
          reason: "has_support_reference",
        } as const;
      }

      if (shouldPreserveUnsupportedSegments(input.answerSupportPolicy)) {
        return {
          originalText: segment.text,
          text: segment.text,
          disposition: VALIDATION_DISPOSITION.UNSUPPORTED,
          replacementApplied: false,
          reason: "missing_support_reference",
        } as const;
      }

      const generatedNotice = await input.unsupportedNoticeGenerator.generate({
        query: input.query,
        unsupportedText: segment.text,
      });

      return {
        originalText: segment.text,
        text: `${preservePrefix(segment.text)}${generatedNotice || DEFAULT_UNSUPPORTED_NOTICE}`,
        disposition: VALIDATION_DISPOSITION.UNSUPPORTED,
        replacementApplied: true,
        reason: "missing_support_reference",
      } as const;
    }));

    const supportedSegmentCount = segmentResults.filter((segment) => segment.disposition === VALIDATION_DISPOSITION.SUPPORTED).length;
    const unsupportedSegmentCount = segmentResults.filter((segment) => segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED).length;
    const nonSubstantiveSegmentCount = segmentResults.filter((segment) => segment.disposition === VALIDATION_DISPOSITION.NON_SUBSTANTIVE).length;

    const visibleSegments = supportedSegmentCount === 0 && unsupportedSegmentCount > 0 && shouldReplaceUnsupportedSegments(input.answerSupportPolicy)
      ? [{
          text: await input.groundedMissResponseComposer.composeUnsupportedWithContext({
            query: input.query,
            unsupportedText: input.answer,
            contexts: input.retrievedContextSummaries,
            conversationMode: input.conversationMode,
            brevityOverrideRequested: input.brevityOverrideRequested,
          }),
        }]
      : this.buildVisibleSegments(segmentResults);

    const { citations, answerSegments } = this.compactVisibleArtifacts(visibleSegments, input.citationEvidence);
    const answer = visibleSegments.map((segment) => segment.text).join("");

    return {
      answer,
      citations: input.citationDisplayEnabled ? citations : undefined,
      answerSegments: input.citationDisplayEnabled ? answerSegments : undefined,
      validation: {
        ran: true,
        answerModified: segmentResults.some((segment) => segment.replacementApplied),
        unsupportedSegmentCount,
        supportedSegmentCount,
        nonSubstantiveSegmentCount,
        answerSupportPolicy: input.answerSupportPolicy,
      },
      segmentResults,
    };
  }

  private buildVisibleSegments(
    segmentResults: Array<{
      text: string;
      disposition: string;
      citationIndices?: number[];
      replacementApplied: boolean;
    }>,
  ): AnswerSegment[] {
    const visibleSegments: AnswerSegment[] = [];
    let latestMeaningfulSegmentText: string | null = null;

    for (const segment of segmentResults) {
      if (
        segment.disposition === VALIDATION_DISPOSITION.NON_SUBSTANTIVE &&
        /^[.!?]+\s*$/.test(segment.text) &&
        latestMeaningfulSegmentText === DEFAULT_UNSUPPORTED_NOTICE
      ) {
        const trailingWhitespace = segment.text.match(/\s+$/)?.[0];
        if (trailingWhitespace) {
          visibleSegments.push({ text: trailingWhitespace });
        }
        continue;
      }

      if (segment.disposition === VALIDATION_DISPOSITION.SUPPORTED && segment.citationIndices) {
        visibleSegments.push({
          text: segment.text,
          citationIndices: segment.citationIndices,
        });
        latestMeaningfulSegmentText = segment.text;
        continue;
      }

      if (
        segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED &&
        latestMeaningfulSegmentText === DEFAULT_UNSUPPORTED_NOTICE &&
        stripPrefix(segment.text) === DEFAULT_UNSUPPORTED_NOTICE
      ) {
        const separatorWhitespace = segment.text.match(/^\s+/)?.[0];
        if (separatorWhitespace) {
          visibleSegments.push({ text: separatorWhitespace });
        }
        continue;
      }

      visibleSegments.push({ text: segment.text });

      if (segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED) {
        latestMeaningfulSegmentText = segment.replacementApplied
          ? DEFAULT_UNSUPPORTED_NOTICE
          : segment.text.trim();
        continue;
      }

      if (
        segment.disposition === VALIDATION_DISPOSITION.NON_SUBSTANTIVE &&
        !/^[\s,.;:!?()/-]*$/.test(segment.text)
      ) {
        latestMeaningfulSegmentText = segment.text.trim();
      }
    }

    while (visibleSegments.length > 0 && /^\s+$/.test(visibleSegments[visibleSegments.length - 1].text)) {
      visibleSegments.pop();
    }

    return visibleSegments;
  }

  private compactVisibleArtifacts(
    answerSegments: AnswerSegment[],
    citationEvidence: CitationEvidence[],
  ): {
    citations: Array<{ documentId: string; chunkId: string; title: string }>;
    answerSegments: AnswerSegment[];
  } {
    const citations: Array<{ documentId: string; chunkId: string; title: string }> = [];
    const indexMap = new Map<number, number>();

    const remappedSegments = answerSegments.map((segment) => {
      if (!segment.citationIndices || segment.citationIndices.length === 0) {
        return { text: segment.text };
      }

      const remappedIndices = segment.citationIndices.flatMap((index) => {
        const citation = citationEvidence[index];
        if (!citation) {
          return [];
        }

        let nextIndex = indexMap.get(index);
        if (nextIndex === undefined) {
          nextIndex = citations.length;
          indexMap.set(index, nextIndex);
          citations.push(toChatCitation(citation));
        }

        return [nextIndex];
      });

      return remappedIndices.length > 0
        ? { text: segment.text, citationIndices: remappedIndices }
        : { text: segment.text };
    });

    return {
      citations,
      answerSegments: remappedSegments,
    };
  }
}
