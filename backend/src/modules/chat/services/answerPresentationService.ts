import { findCitationAnchorGroups, stripResidualCitationSyntax } from "./citationAnchorParser.js";
import { STRANDABLE_PUNCTUATION } from "./citationTextNormalization.js";
import type {
  AnswerSegment,
  ChatCitation,
  CitationEvidence,
  NormalizedPresentedAnswer,
  PresentedAnswer,
} from "../contracts/answerTypes.js";

export const remapAnswerSegmentsToCitationEvidence = (
  answerSegments: AnswerSegment[],
  visibleCitationEvidence: CitationEvidence[],
  targetCitationEvidence: CitationEvidence[],
): AnswerSegment[] => {
  const targetIndexByDocumentId = new Map<string, number>();

  for (const [index, citation] of targetCitationEvidence.entries()) {
    if (!targetIndexByDocumentId.has(citation.documentId)) {
      targetIndexByDocumentId.set(citation.documentId, index);
    }
  }

  return answerSegments.map((segment) => {
    if (!segment.citationIndices || segment.citationIndices.length === 0) {
      return { text: segment.text };
    }

    const remappedIndices = [...new Set(segment.citationIndices.flatMap((index) => {
      const citation = visibleCitationEvidence[index];
      if (!citation) {
        return [];
      }

      const remappedIndex = targetIndexByDocumentId.get(citation.documentId);
      return remappedIndex === undefined ? [] : [remappedIndex];
    }))];

    return remappedIndices.length > 0
      ? { text: segment.text, citationIndices: remappedIndices }
      : { text: segment.text };
  });
};

const hasParagraphBreak = (text: string): boolean => /\r?\n\r?\n/.test(text);
const MARKDOWN_LINK_LINE_END = /((?:\*\*)?\[[^\]\n]+]\([^\s)\n]+(?:\([^\s)\n]*\)[^\s)\n]*)?\)(?:\*\*)?)([ \t]*)$/;
const LIST_ITEM_START = /^\s{0,3}(?:[-+*]|\d+\.)\s+/;
const SENTENCE_START = /^\s*(?:["'“‘(]*[\p{Lu}]|If\b|You\b|For\b|To\b|In\b|On\b)/u;

const sameCitationIndices = (left?: number[], right?: number[]): boolean => {
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
};

const toChatCitation = (citation: CitationEvidence): ChatCitation => {
  const chatCitation: ChatCitation = {
    documentId: citation.documentId,
    chunkId: citation.chunkId,
    title: citation.title,
  };
  if (citation.sourceUrl) {
    chatCitation.sourceUrl = citation.sourceUrl;
  }
  return chatCitation;
};

const addMissingPunctuationAfterTerminalMarkdownLinks = (text: string): string => {
  const lines = text.split(/\n/);

  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";

    if (LIST_ITEM_START.test(line) || LIST_ITEM_START.test(nextLine) || !SENTENCE_START.test(nextLine)) {
      continue;
    }

    lines[index] = line.replace(MARKDOWN_LINK_LINE_END, "$1.$2");
  }

  return lines.join("\n");
};

export class AnswerPresentationService {
  normalize(input: {
    answer: string;
    citations: CitationEvidence[];
  }): NormalizedPresentedAnswer {
    const trimmedAnswer = addMissingPunctuationAfterTerminalMarkdownLinks(input.answer.trim());
    return this.normalizeAnchoredAnswer(trimmedAnswer, input.citations);
  }

  present(input: {
    answer: string;
    citations: CitationEvidence[];
  }): PresentedAnswer {
    const normalized = this.normalize({
      answer: input.answer,
      citations: input.citations,
    });

    if (normalized.citationEvidence.length === 0) {
      return { answer: normalized.answer };
    }

    return {
      answer: normalized.answer,
      citations: normalized.citationEvidence.map((citation) => toChatCitation(citation)),
      answerSegments: normalized.answerSegments,
    };
  }

  private normalizeAnchoredAnswer(answer: string, citations: CitationEvidence[]): {
    answer: string;
    citationEvidence: CitationEvidence[];
    answerSegments: AnswerSegment[];
  } {
    const anchorGroups = findCitationAnchorGroups(answer);
    const visibleCitations: CitationEvidence[] = [];
    const citationIndexByDocument = new Map<string, number>();
    const answerSegments: AnswerSegment[] = [];

    let answerText = "";
    let currentText = "";
    let lastIndex = 0;

    const pushSegment = (text: string, citationIndices?: number[]) => {
      if (text.length === 0) {
        return;
      }

      const previousSegment = answerSegments.at(-1);
      if (
        citationIndices &&
        citationIndices.length > 0 &&
        previousSegment?.citationIndices &&
        sameCitationIndices(previousSegment.citationIndices, citationIndices) &&
        !hasParagraphBreak(text)
      ) {
        previousSegment.text += text;
        answerText += text;
        return;
      }

      const segment = citationIndices && citationIndices.length > 0
        ? { text, citationIndices }
        : { text };
      answerSegments.push(segment);
      answerText += text;
    };

    const resolveCitationIndices = (resultNumbers: number[]): number[] => {
      const resolvedIndices: number[] = [];

      for (const resultNumber of resultNumbers) {
        const citation = citations[resultNumber - 1];
        if (!citation) {
          continue;
        }

        let citationIndex = citationIndexByDocument.get(citation.documentId);
        if (citationIndex === undefined) {
          citationIndex = visibleCitations.length;
          citationIndexByDocument.set(citation.documentId, citationIndex);
          visibleCitations.push(citation);
        }

        if (!resolvedIndices.includes(citationIndex)) {
          resolvedIndices.push(citationIndex);
        }
      }

      return resolvedIndices;
    };

    for (const anchorGroup of anchorGroups) {
      currentText += stripResidualCitationSyntax(answer.slice(lastIndex, anchorGroup.start));

      const citationIndices = resolveCitationIndices(anchorGroup.resultNumbers);
      const match = currentText.match(/^(.*?)(\s*)$/s);
      const coreText = match?.[1] ?? currentText;
      let trailingWhitespace = match?.[2] ?? "";

      // The model sometimes detaches an anchor onto its own line just before the
      // punctuation that closes the claim (`claim\n\n[[1]].`). Removing the anchor would
      // otherwise strand that punctuation on a new line, so when the whitespace before
      // the anchor spans a line break and the text after it opens with sentence
      // punctuation, drop the break so the punctuation rejoins the claim. Scoped to the
      // anchor seam — newlines elsewhere in the answer are never touched.
      if (/\n/.test(trailingWhitespace) && STRANDABLE_PUNCTUATION.test(answer.slice(anchorGroup.end))) {
        trailingWhitespace = "";
      }

      if (citationIndices.length > 0 && coreText.length > 0) {
        pushSegment(coreText, citationIndices);
        currentText = trailingWhitespace;
      } else {
        currentText = `${coreText}${trailingWhitespace}`;
      }

      lastIndex = anchorGroup.end;
    }

    currentText += stripResidualCitationSyntax(answer.slice(lastIndex));
    pushSegment(currentText);

    return {
      answer: answerText,
      citationEvidence: visibleCitations,
      answerSegments,
    };
  }
}
