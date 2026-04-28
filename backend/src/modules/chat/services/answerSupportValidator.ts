import type { AnswerSegment, CitationEvidence } from "./answerPresentationService.js";
import type { ConversationMode } from "../../settings/domain/retrievalSettings.js";
import {
  type HiddenSupportEvidence,
  type ValidatedAnswer,
  VALIDATION_DISPOSITION,
} from "./answerSupportValidationTypes.js";
import type { GroundedMissResponseComposer } from "./groundedMissResponseComposer.js";

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });

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

const extractNormalizedWordTokens = (value: string): string[] => {
  const tokens: string[] = [];

  for (const segment of wordSegmenter.segment(value.normalize("NFKC").toLowerCase())) {
    if (!segment.isWordLike) {
      continue;
    }

    const normalized = segment.segment.replace(/[^\p{L}\p{N}]+/gu, "");
    if (normalized.length === 0) {
      continue;
    }

    tokens.push(normalized);
  }

  return tokens;
};

const containsTokenSequence = (tokens: string[], sequence: string[]): boolean => {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }

  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    if (sequence.every((token, offset) => tokens[index + offset] === token)) {
      return true;
    }
  }

  return false;
};

const countWordLikeTokens = (value: string): number => {
  let count = 0;

  for (const segment of wordSegmenter.segment(value)) {
    if (segment.isWordLike) {
      count += 1;
    }
  }

  return count;
};

const isNonSubstantiveText = (value: string): boolean => {
  return !hasWordLikeContent(value);
};

const splitIntoSentenceLikeSegments = (value: string): string[] => {
  const rawSegments = [...sentenceSegmenter.segment(value)]
    .map((segment) => segment.segment)
    .filter((segment) => segment.length > 0);

  if (rawSegments.length <= 1) {
    return [value];
  }

  const segments: string[] = [];
  let carry = "";

  for (const segment of rawSegments) {
    if (!hasWordLikeContent(segment)) {
      carry += segment;
      continue;
    }

    segments.push(`${carry}${segment}`);
    carry = "";
  }

  if (carry.length > 0) {
    if (segments.length === 0) {
      segments.push(carry);
    } else {
      segments[segments.length - 1] += carry;
    }
  }

  const rebuilt = segments.join("");
  return rebuilt === value ? segments : [value];
};

const preservePrefix = (value: string): string => value.match(/^[\s,.;:!?()/-]*/)?.[0] ?? "";
const OMITTED_UNSUPPORTED_SENTINEL = "__omitted_unsupported__";
const MARKDOWN_LINK_URL_PATTERN = /\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/gi;
const BARE_URL_PATTERN = /https?:\/\/[^\s<>)"']+/gi;
const trimBareUrlPunctuation = (value: string): string => value.replace(/[.,;:!?]+$/g, "");

const normalizeUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    url.hash = "";
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/g, "");
    }
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
    urls.push(trimBareUrlPunctuation(match[0]));
  }

  return urls;
};

const extractNormalizedUrls = (value: string): string[] =>
  [...new Set(
    extractUrls(value)
      .map((url) => normalizeUrl(url))
      .filter((url): url is string => Boolean(url)),
  )];

const stripLinksAndUrls = (value: string): string =>
  value
    .replace(MARKDOWN_LINK_URL_PATTERN, "")
    .replace(BARE_URL_PATTERN, "")
    .replace(/\[[^\]]+\]\(\s*\)/g, "")
    .trim();

const sameCitationIndices = (left?: number[], right?: number[]): boolean => {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
};

const hasParagraphBreak = (text: string): boolean => /\r?\n\r?\n/.test(text);

const collectLinkSpans = (value: string): Array<{ start: number; end: number }> => {
  const spans: Array<{ start: number; end: number }> = [];
  const markdownLinkPattern = new RegExp(MARKDOWN_LINK_URL_PATTERN.source, "gi");

  for (const match of value.matchAll(markdownLinkPattern)) {
    if (match.index === undefined) {
      continue;
    }

    spans.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  const bareUrlPattern = new RegExp(BARE_URL_PATTERN.source, "gi");
  for (const match of value.matchAll(bareUrlPattern)) {
    if (match.index === undefined) {
      continue;
    }

    const start = match.index;
    if (spans.some((span) => start >= span.start && start < span.end)) {
      continue;
    }

    spans.push({
      start,
      end: start + trimBareUrlPunctuation(match[0]).length,
    });
  }

  return spans.sort((left, right) => left.start - right.start);
};

const extractSupportedLinkText = (value: string): string | null => {
  const linkSpans = collectLinkSpans(value);
  if (linkSpans.length === 0) {
    return null;
  }

  const firstSpan = linkSpans[0];
  const lastSpan = linkSpans[linkSpans.length - 1];
  let trailingIndex = lastSpan.end;

  while (trailingIndex < value.length && /[\s,.;:!?()/-]/.test(value[trailingIndex] ?? "")) {
    trailingIndex += 1;
  }

  return `${preservePrefix(value.slice(0, firstSpan.start))}${value.slice(firstSpan.start, trailingIndex)}`;
};

const normalizeOmittedUnsupportedPrefix = (value: string): string => value.replace(/^\s+/g, "");
const normalizePunctuationOnlySegment = (value: string): string => value.replace(/^\s+/, "");

const toChatCitation = (citation: CitationEvidence) => ({
  documentId: citation.documentId,
  chunkId: citation.chunkId,
  title: citation.title,
});

export class AnswerSupportValidator {
  private expandValidationSegments(answerSegments: AnswerSegment[]): AnswerSegment[] {
    const expandedSegments: AnswerSegment[] = [];

    for (const segment of answerSegments) {
      if ((segment.citationIndices?.length ?? 0) > 0) {
        expandedSegments.push(segment);
        continue;
      }

      for (const text of splitIntoSentenceLikeSegments(segment.text)) {
        expandedSegments.push({ text });
      }
    }

    return expandedSegments;
  }

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

  private resolveSourceUrlCitationSupport(
    segment: AnswerSegment,
    citationEvidence: CitationEvidence[],
  ): { citationIndices: number[]; supportedText: string; replacementApplied: boolean } | undefined {
    if ((segment.citationIndices?.length ?? 0) > 0) {
      return {
        citationIndices: segment.citationIndices ?? [],
        supportedText: segment.text,
        replacementApplied: false,
      };
    }

    const normalizedUrls = extractNormalizedUrls(segment.text);

    if (normalizedUrls.length === 0) {
      return undefined;
    }

    const citationUrlSets = citationEvidence.map((citation) => {
      const citationUrls = new Set<string>();
      const normalizedSourceUrl = citation.sourceUrl ? normalizeUrl(citation.sourceUrl) : null;
      if (normalizedSourceUrl) {
        citationUrls.add(normalizedSourceUrl);
      }
      for (const url of extractNormalizedUrls(citation.content)) {
        citationUrls.add(url);
      }
      for (const url of extractNormalizedUrls(citation.title)) {
        citationUrls.add(url);
      }
      return citationUrls;
    });

    const matchingIndices: number[] = [];

    for (const url of normalizedUrls) {
      const matchesForUrl = citationUrlSets.flatMap((citationUrls, index) => (
        citationUrls.has(url) ? [index] : []
      ));

      if (matchesForUrl.length === 0) {
        return undefined;
      }

      const preferredIndex = matchesForUrl.find((index) => (
        citationEvidence[index]?.sourceUrl ? normalizeUrl(citationEvidence[index].sourceUrl!) === url : false
      )) ?? matchesForUrl[0];

      if (!matchingIndices.includes(preferredIndex)) {
        matchingIndices.push(preferredIndex);
      }
    }

    const residualText = stripLinksAndUrls(segment.text);
    if (!hasWordLikeContent(residualText) || isNonSubstantiveText(residualText)) {
      return matchingIndices.length > 0
        ? {
            citationIndices: matchingIndices,
            supportedText: segment.text,
            replacementApplied: false,
          }
        : undefined;
    }

    const supportedLinkText = extractSupportedLinkText(segment.text);
    if (!supportedLinkText) {
      return undefined;
    }

    return {
      citationIndices: matchingIndices,
      supportedText: supportedLinkText,
      replacementApplied: supportedLinkText !== segment.text,
    };
  }

  private resolveHiddenSupportEvidenceKinds(
    segment: AnswerSegment,
    hiddenSupportEvidence: HiddenSupportEvidence[],
  ): HiddenSupportEvidence["kind"][] | undefined {
    if (hiddenSupportEvidence.length === 0) {
      return undefined;
    }

    const segmentTokens = extractNormalizedWordTokens(segment.text);
    if (segmentTokens.length === 0) {
      return undefined;
    }

    const supportKinds = new Set<HiddenSupportEvidence["kind"]>();
    const coveredTokens = new Set<string>();

    for (const evidence of hiddenSupportEvidence) {
      const evidenceTokens = extractNormalizedWordTokens(evidence.content);
      if (evidenceTokens.length === 0) {
        continue;
      }

      if (containsTokenSequence(segmentTokens, evidenceTokens)) {
        supportKinds.add(evidence.kind);
        for (const token of evidenceTokens) {
          coveredTokens.add(token);
        }
      }
    }

    if (supportKinds.size === 0) {
      return undefined;
    }

    const unsupportedTokens = segmentTokens.filter((token) => token.length > 4 && !coveredTokens.has(token));
    if (unsupportedTokens.length > 0) {
      return undefined;
    }

    return [...supportKinds];
  }

  async validate(input: {
    query: string;
    answer: string;
    answerSegments: AnswerSegment[];
    citationEvidence: CitationEvidence[];
    hiddenSupportEvidence?: HiddenSupportEvidence[];
    retrievedContextSummaries: Array<{ title: string; content: string }>;
    citationDisplayEnabled: boolean;
    conversationMode: ConversationMode;
    groundedMissResponseComposer: GroundedMissResponseComposer;
    unsupportedNoticeMarked?: boolean;
    userExpectedLocale?: string | null;
  }): Promise<ValidatedAnswer> {
    const validationSegments = this.expandValidationSegments(input.answerSegments);
    const segmentResults = await Promise.all(validationSegments.map(async (segment) => {
      const sourceUrlSupport = this.resolveSourceUrlCitationSupport(segment, input.citationEvidence);
      const citationIndices =
        sourceUrlSupport?.citationIndices
        ?? this.resolveImplicitCitationIndices(segment, input.citationEvidence);
      const hiddenSupportKinds = this.resolveHiddenSupportEvidenceKinds(
        segment,
        input.hiddenSupportEvidence ?? [],
      );

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
          text: sourceUrlSupport?.supportedText ?? segment.text,
          disposition: VALIDATION_DISPOSITION.SUPPORTED,
          citationIndices,
          replacementApplied: sourceUrlSupport?.replacementApplied ?? false,
          reason: sourceUrlSupport?.replacementApplied ? "has_support_reference_link_only" : "has_support_reference",
        } as const;
      }

      if ((hiddenSupportKinds?.length ?? 0) > 0) {
        const presentHiddenSupportKinds = hiddenSupportKinds ?? [];
        return {
          originalText: segment.text,
          text: segment.text,
          disposition: VALIDATION_DISPOSITION.SUPPORTED,
          replacementApplied: false,
          reason: `has_hidden_support_reference:${presentHiddenSupportKinds.join(",")}`,
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
    const hiddenSupportKindsUsed = [...new Set(
      segmentResults.flatMap((segment) => {
        if (!segment.reason.startsWith("has_hidden_support_reference:")) {
          return [];
        }

        return segment.reason
          .slice("has_hidden_support_reference:".length)
          .split(",")
          .filter((kind): kind is HiddenSupportEvidence["kind"] => (
            kind === "assistant_name" || kind === "assistant_role"
          ));
      }),
    )];
    const hiddenSupportUsed = hiddenSupportKindsUsed.length > 0 ? true : undefined;

    const preserveModelUnsupportedNotice =
      Boolean(input.unsupportedNoticeMarked)
      && supportedSegmentCount === 0
      && substantiveUnsupportedSegmentCount > 0;

    const effectiveSegmentResults = preserveModelUnsupportedNotice
      ? segmentResults.map((segment) => (
          segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED
            ? {
                ...segment,
                text: segment.originalText,
                replacementApplied: false,
                reason: "model_marked_unsupported_notice",
              }
            : segment
        ))
      : segmentResults;

    const visibleSegments = preserveModelUnsupportedNotice
      ? this.buildVisibleSegments(effectiveSegmentResults)
      : supportedSegmentCount === 0 && unsupportedSegmentCount > 0
        ? [{
            text: await input.groundedMissResponseComposer.composeUnsupportedWithContext({
              query: input.query,
              unsupportedText: input.answer,
              contexts: input.retrievedContextSummaries,
              conversationMode: input.conversationMode,
              userExpectedLocale: input.userExpectedLocale,
            }),
          }]
        : supportedSegmentCount > 0 && unsupportedSegmentCount > 0
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
        answerModified: effectiveSegmentResults.some((segment) => segment.replacementApplied),
        unsupportedSegmentCount,
        substantiveUnsupportedSegmentCount,
        supportedSegmentCount,
        nonSubstantiveSegmentCount,
        hiddenSupportUsed,
        hiddenSupportKindsUsed: hiddenSupportUsed ? hiddenSupportKindsUsed : undefined,
      },
      segmentResults: effectiveSegmentResults,
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

      if (segment.disposition === VALIDATION_DISPOSITION.SUPPORTED) {
        visibleSegments.push({ text: segment.text });
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
      if (segment.disposition === VALIDATION_DISPOSITION.SUPPORTED) {
        visibleSegments.push(
          segment.citationIndices
            ? {
                text: segment.text,
                citationIndices: segment.citationIndices,
              }
            : { text: segment.text },
        );
        omittedUnsupported = false;
        continue;
      }

      if (segment.disposition === VALIDATION_DISPOSITION.UNSUPPORTED) {
        const prefix = normalizeOmittedUnsupportedPrefix(preservePrefix(segment.text));
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

      visibleSegments.push({ text: punctuationOnly ? normalizePunctuationOnlySegment(segment.text) : segment.text });
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

    const mergedSegments: AnswerSegment[] = [];
    for (const segment of remappedSegments) {
      const previous = mergedSegments.at(-1);

      if (!segment.citationIndices || segment.citationIndices.length === 0) {
        if (/^\s+$/.test(segment.text)) {
          continue;
        }

        mergedSegments.push(segment);
        continue;
      }

      if (
        previous?.citationIndices
        && sameCitationIndices(previous.citationIndices, segment.citationIndices)
        && !hasParagraphBreak(segment.text)
      ) {
        previous.text += segment.text;
        continue;
      }

      mergedSegments.push(segment);
    }

    return {
      citations,
      answerSegments: mergedSegments,
    };
  }
}
