export interface ChatCitation {
  documentId: string;
  chunkId: string;
  title: string;
}

export interface CitationEvidence extends ChatCitation {
  content: string;
}

export interface AnswerSegment {
  text: string;
  citationIndices?: number[];
}

export interface PresentedAnswer {
  answer: string;
  citations?: ChatCitation[];
  answerSegments?: AnswerSegment[];
}

export class AnswerPresentationService {
  present(input: {
    answer: string;
    citations: CitationEvidence[];
    citationDisplayEnabled: boolean;
  }): PresentedAnswer {
    const answer = input.answer.trim();

    if (!input.citationDisplayEnabled) {
      return { answer };
    }

    const citations = this.deduplicateCitations(input.citations);
    if (citations.length === 0) {
      return { answer };
    }

    const rawSegments = this.splitIntoSegments(answer);
    const answerSegments = this.assignCitationsToSegments(rawSegments, citations);

    return {
      answer,
      citations: citations.map(({ documentId, chunkId, title }) => ({ documentId, chunkId, title })),
      answerSegments,
    };
  }

  private deduplicateCitations(citations: CitationEvidence[]): CitationEvidence[] {
    const dedupedByDocument = new Map<string, CitationEvidence>();

    for (const citation of citations) {
      const existing = dedupedByDocument.get(citation.documentId);
      if (!existing) {
        dedupedByDocument.set(citation.documentId, { ...citation });
        continue;
      }

      if (!existing.title.trim() && citation.title.trim()) {
        existing.title = citation.title;
      }

      if (citation.content.trim().length === 0) {
        continue;
      }

      const existingParts = new Set(existing.content.split("\n\n").map((part) => part.trim()).filter(Boolean));
      if (!existingParts.has(citation.content.trim())) {
        existing.content = existing.content.trim().length > 0
          ? `${existing.content}\n\n${citation.content}`
          : citation.content;
      }
    }

    return [...dedupedByDocument.values()];
  }

  private splitIntoSegments(answer: string): string[] {
    const segments: string[] = [];
    let current = "";

    for (let index = 0; index < answer.length; index += 1) {
      const char = answer[index];
      current += char;

      if (!char) {
        continue;
      }

      if (!this.isSegmentBoundary(answer, index, char)) {
        continue;
      }

      while (index + 1 < answer.length && /\s/.test(answer[index + 1] ?? "")) {
        index += 1;
        current += answer[index] ?? "";
      }

      if (current.trim().length > 0) {
        segments.push(current);
      }
      current = "";
    }

    if (current.trim().length > 0) {
      segments.push(current);
    }

    return segments.length > 0 ? segments : [answer];
  }

  private isSegmentBoundary(answer: string, index: number, char: string): boolean {
    if (char === "\n" || char === "!" || char === "?") {
      return true;
    }

    const previousChar = answer[index - 1] ?? "";
    const nextChar = answer[index + 1] ?? "";

    if (char === ",") {
      if (/\d/.test(previousChar) && /\d/.test(nextChar)) {
        return false;
      }

      return true;
    }

    if (char === ".") {
      if (/\d/.test(previousChar) && /\d/.test(nextChar)) {
        return false;
      }

      if (/[A-Za-z0-9]/.test(previousChar) && /[A-Za-z0-9/#?&=_-]/.test(nextChar)) {
        return false;
      }

      if (previousChar === "." || nextChar === ".") {
        return false;
      }

      return true;
    }

    if (char === ";") {
      return true;
    }

    return false;
  }

  private assignCitationsToSegments(segments: string[], citations: CitationEvidence[]): AnswerSegment[] {
    const segmentCitationMap = segments.map(() => [] as number[]);
    const segmentTokenSets = segments.map((segment) => this.toTokenSet(segment));
    const citationTokenSets = citations.map((citation) => this.toTokenSet(`${citation.title} ${citation.content}`));

    segments.forEach((_segment, segmentIndex) => {
      const scores = citations.map((_citation, citationIndex) =>
        this.scoreTokenOverlap(segmentTokenSets[segmentIndex], citationTokenSets[citationIndex]),
      );
      const bestScore = Math.max(0, ...scores);

      if (bestScore <= 0) {
        return;
      }

      scores.forEach((score, citationIndex) => {
        if (score === bestScore) {
          segmentCitationMap[segmentIndex].push(citationIndex);
        }
      });
    });

    citations.forEach((_citation, citationIndex) => {
      const alreadyUsed = segmentCitationMap.some((indices) => indices.includes(citationIndex));
      if (alreadyUsed) {
        return;
      }

      let bestSegmentIndex = 0;
      let bestScore = -1;

      segmentTokenSets.forEach((segmentTokens, segmentIndex) => {
        const score = this.scoreTokenOverlap(segmentTokens, citationTokenSets[citationIndex]);
        if (score > bestScore) {
          bestScore = score;
          bestSegmentIndex = segmentIndex;
        }
      });

      if (bestScore <= 0) {
        bestSegmentIndex = segments.length === 1
          ? 0
          : Math.round((citationIndex * (segments.length - 1)) / Math.max(1, citations.length - 1));
      }

      segmentCitationMap[bestSegmentIndex].push(citationIndex);
    });

    const normalizedSegments = segments.map((text, index) => ({
      text,
      citationIndices: [...new Set(segmentCitationMap[index])].sort((left, right) => left - right),
    }));

    for (let index = 0; index < normalizedSegments.length - 1; index += 1) {
      const current = normalizedSegments[index];
      const next = normalizedSegments[index + 1];

      if (
        current.citationIndices.length > 0 &&
        current.citationIndices.length === next.citationIndices.length &&
        current.citationIndices.every((value, valueIndex) => value === next.citationIndices[valueIndex])
      ) {
        current.citationIndices = [];
      }
    }

    return normalizedSegments.map((segment) =>
      segment.citationIndices.length > 0
        ? segment
        : { text: segment.text },
    );
  }

  private toTokenSet(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/\W+/)
        .map((token) => token.replace(/(ing|ed|es|s)$/i, ""))
        .filter((token) => token.length > 2)
        .filter((token) => !STOP_WORDS.has(token)),
    );
  }

  private scoreTokenOverlap(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) {
      return 0;
    }

    let matches = 0;
    for (const token of left) {
      if (right.has(token)) {
        matches += 1;
      }
    }

    return matches;
  }
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "what",
  "when",
  "where",
  "which",
  "who",
  "how",
  "why",
  "are",
  "was",
  "were",
  "is",
  "it",
  "its",
  "a",
  "an",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "be",
  "or",
  "do",
  "doe",
]);
