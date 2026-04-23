import type { AnswerSegment, CitationEvidence } from "./answerPresentationService.js";
import type { AnswerSupportPolicy, ConversationMode } from "../../settings/domain/retrievalSettings.js";
import { shouldPreserveUnsupportedSegments, shouldReplaceUnsupportedSegments } from "./answerSupportPolicy.js";
import {
  type ValidatedAnswer,
  VALIDATION_DISPOSITION,
} from "./answerSupportValidationTypes.js";
import type { GroundedMissResponseComposer } from "./groundedMissResponseComposer.js";

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const hasWordLikeContent = (value: string): boolean => {
  for (const segment of wordSegmenter.segment(value)) {
    if (segment.isWordLike) {
      return true;
    }
  }

  return false;
};

const extractSignificantTerms = (value: string): string[] => {
  const terms: string[] = [];

  for (const segment of wordSegmenter.segment(value.normalize("NFKC").toLowerCase())) {
    if (!segment.isWordLike) {
      continue;
    }

    const normalized = segment.segment.replace(/[^\p{L}\p{N}]+/gu, "");
    if (normalized.length < 4) {
      continue;
    }
    terms.push(normalized);
  }

  return [...new Set(terms)];
};

const isNonSubstantiveText = (value: string): boolean => {
  return !hasWordLikeContent(value);
};

const preservePrefix = (value: string): string => value.match(/^[\s,.;:!?()/-]*/)?.[0] ?? "";
const OMITTED_UNSUPPORTED_SENTINEL = "__omitted_unsupported__";
const MARKDOWN_LINK_URL_PATTERN = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi;
const BARE_URL_PATTERN = /https?:\/\/[^\s<>)"']+/gi;

const normalizeUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
};

const extractUrls = (value: string): string[] => {
  const urls: string[] = [];

  for (const match of value.matchAll(MARKDOWN_LINK_URL_PATTERN)) {
    if (match[1]) {
      urls.push(match[1]);
    }
  }

  const withoutMarkdownLinks = value.replace(MARKDOWN_LINK_URL_PATTERN, "");
  for (const match of withoutMarkdownLinks.matchAll(BARE_URL_PATTERN)) {
    urls.push(match[0]);
  }

  return urls;
};

const toChatCitation = (citation: CitationEvidence) => ({
  documentId: citation.documentId,
  chunkId: citation.chunkId,
  title: citation.title,
});

export class AnswerSupportValidator {
  private resolveImplicitCitationIndices(segment: AnswerSegment, citationEvidence: CitationEvidence[]): number[] | undefined {
    if ((segment.citationIndices?.length ?? 0) > 0) {
      return segment.citationIndices;
    }

    const segmentTerms = extractSignificantTerms(segment.text);
    if (segmentTerms.length < 3) {
      return undefined;
    }

    const scores = citationEvidence
      .map((citation, index) => {
        const citationTerms = new Set(extractSignificantTerms(`${citation.title} ${citation.content}`));
        const matchedTerms = segmentTerms.filter((term) => citationTerms.has(term));
        return {
          index,
          matches: matchedTerms.length,
          ratio: matchedTerms.length / segmentTerms.length,
        };
      })
      .filter((score) => score.matches >= 2)
      .sort((left, right) => {
        if (right.ratio !== left.ratio) {
          return right.ratio - left.ratio;
        }
        return right.matches - left.matches;
      });

    const best = scores[0];
    const second = scores[1];
    if (!best) {
      return undefined;
    }

    if (best.ratio < 0.5) {
      return undefined;
    }

    if (second && best.ratio < 0.7 && best.matches <= second.matches) {
      return undefined;
    }

    return [best.index];
  }

  private resolveSourceUrlCitationIndices(segment: AnswerSegment, citationEvidence: CitationEvidence[]): number[] | undefined {
    if ((segment.citationIndices?.length ?? 0) > 0) {
      return segment.citationIndices;
    }

    const normalizedUrls = [...new Set(
      extractUrls(segment.text)
        .map((url) => normalizeUrl(url))
        .filter((url): url is string => Boolean(url)),
    )];

    if (normalizedUrls.length === 0) {
      return undefined;
    }

    const matchingIndices = citationEvidence.flatMap((citation, index) => {
      const normalizedSourceUrl = citation.sourceUrl ? normalizeUrl(citation.sourceUrl) : null;
      if (!normalizedSourceUrl) {
        return [];
      }

      return normalizedUrls.every((url) => url === normalizedSourceUrl) ? [index] : [];
    });

    return matchingIndices.length > 0 ? matchingIndices : undefined;
  }

  async validate(input: {
    query: string;
    answer: string;
    answerSegments: AnswerSegment[];
    citationEvidence: CitationEvidence[];
    retrievedContextSummaries: Array<{ title: string; content: string }>;
    citationDisplayEnabled: boolean;
    answerSupportPolicy: AnswerSupportPolicy;
    conversationMode: ConversationMode;
    groundedMissResponseComposer: GroundedMissResponseComposer;
  }): Promise<ValidatedAnswer> {
    const segmentResults = await Promise.all(input.answerSegments.map(async (segment) => {
      const citationIndices =
        this.resolveSourceUrlCitationIndices(segment, input.citationEvidence)
        ?? this.resolveImplicitCitationIndices(segment, input.citationEvidence);

      if (isNonSubstantiveText(segment.text)) {
        return {
          originalText: segment.text,
          text: segment.text,
          disposition: VALIDATION_DISPOSITION.NON_SUBSTANTIVE,
          citationIndices,
          replacementApplied: false,
          reason: "non_substantive_text",
        } as const;
      }

      if ((citationIndices?.length ?? 0) > 0) {
        return {
          originalText: segment.text,
          text: segment.text,
          disposition: VALIDATION_DISPOSITION.SUPPORTED,
          citationIndices,
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

      return {
        originalText: segment.text,
        text: preservePrefix(segment.text),
        disposition: VALIDATION_DISPOSITION.UNSUPPORTED,
        replacementApplied: true,
        reason: "missing_support_reference",
      } as const;
    }));

    const supportedSegmentCount = segmentResults.filter((segment) => segment.disposition === VALIDATION_DISPOSITION.SUPPORTED).length;
    const unsupportedSegmentCount = segmentResults.filter((segment) => segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED).length;
    const substantiveUnsupportedSegmentCount = segmentResults.filter(
      (segment) =>
        segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED
        && hasWordLikeContent(segment.originalText),
    ).length;
    const nonSubstantiveSegmentCount = segmentResults.filter((segment) => segment.disposition === VALIDATION_DISPOSITION.NON_SUBSTANTIVE).length;

    const visibleSegments = supportedSegmentCount === 0 && unsupportedSegmentCount > 0 && shouldReplaceUnsupportedSegments(input.answerSupportPolicy)
      ? [{
          text: await input.groundedMissResponseComposer.composeUnsupportedWithContext({
            query: input.query,
            unsupportedText: input.answer,
            contexts: input.retrievedContextSummaries,
            conversationMode: input.conversationMode,
          }),
        }]
      : supportedSegmentCount > 0 && unsupportedSegmentCount > 0 && shouldReplaceUnsupportedSegments(input.answerSupportPolicy)
        ? this.buildVisibleSegmentsWithoutUnsupported(segmentResults)
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
        substantiveUnsupportedSegmentCount,
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
        latestMeaningfulSegmentText === OMITTED_UNSUPPORTED_SENTINEL
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
        latestMeaningfulSegmentText === OMITTED_UNSUPPORTED_SENTINEL &&
        segment.text.length === 0
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
          ? OMITTED_UNSUPPORTED_SENTINEL
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

    const lastSegment = visibleSegments[visibleSegments.length - 1];
    if (lastSegment) {
      lastSegment.text = lastSegment.text.replace(/\s+$/g, "");
      if (lastSegment.text.length === 0) {
        visibleSegments.pop();
      }
    }

    return visibleSegments;
  }

  private buildVisibleSegmentsWithoutUnsupported(
    segmentResults: Array<{
      text: string;
      disposition: string;
      citationIndices?: number[];
      replacementApplied: boolean;
    }>,
  ): AnswerSegment[] {
    const visibleSegments: AnswerSegment[] = [];
    let omittedUnsupported = false;

    for (const segment of segmentResults) {
      if (segment.disposition === VALIDATION_DISPOSITION.SUPPORTED && segment.citationIndices) {
        visibleSegments.push({
          text: segment.text,
          citationIndices: segment.citationIndices,
        });
        omittedUnsupported = false;
        continue;
      }

      if (segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED) {
        const prefix = preservePrefix(segment.text);
        if (visibleSegments.length > 0 && /[.,;:!?()/-]/.test(prefix)) {
          visibleSegments.push({ text: prefix });
        }
        omittedUnsupported = true;
        continue;
      }

      const punctuationOnly = /^[\s,.;:!?()/-]*$/.test(segment.text);
      if (omittedUnsupported && punctuationOnly) {
        omittedUnsupported = false;
        continue;
      }

      if (visibleSegments.length === 0 && punctuationOnly) {
        continue;
      }

      visibleSegments.push({ text: segment.text });
      omittedUnsupported = false;
    }

    while (visibleSegments.length > 0 && /^\s+$/.test(visibleSegments[visibleSegments.length - 1].text)) {
      visibleSegments.pop();
    }

    const lastSegment = visibleSegments[visibleSegments.length - 1];
    if (lastSegment) {
      lastSegment.text = lastSegment.text.replace(/\s+$/g, "");
      if (lastSegment.text.length === 0) {
        visibleSegments.pop();
      }
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
