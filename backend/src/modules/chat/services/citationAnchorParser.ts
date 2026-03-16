import type { AnswerSegment, ChatCitation, CitationEvidence, PresentedAnswer } from "./answerPresentationService.js";

const COMPLETE_ANCHOR = /\[\[(\d+)\]\]/g;
const ANY_BRACKET_ANCHOR = /\[\[[^\]]*?\]\]/g;

const normalizeVisibleWhitespace = (text: string): string =>
  text
    .replace(ANY_BRACKET_ANCHOR, "")
    .replace(/\[\[[^\]]*$/g, "") // strip dangling partial anchors
    .replace(/[ \t]{2,}/g, " ")
    .trim();

export class CitationAnchorParser {
  present(input: { answer: string; citations: CitationEvidence[] }): PresentedAnswer {
    const raw = input.answer ?? "";
    const contexts = input.citations ?? [];

    const segments: Array<{ text: string; anchorNumbers?: number[] }> = [];

    let cursor = 0;
    let segmentText = "";
    let pendingAnchors: number[] = [];

    const finalizeSegment = () => {
      if (segmentText.length === 0) {
        pendingAnchors = [];
        return;
      }

      const normalizedText = segmentText
        .replace(ANY_BRACKET_ANCHOR, "")
        .replace(/\[\[[^\]]*$/g, "")
        .replace(/[ \t]+$/g, "");
      if (normalizedText.length === 0) {
        segmentText = "";
        pendingAnchors = [];
        return;
      }

      const entry: { text: string; anchorNumbers?: number[] } = pendingAnchors.length > 0
        ? { text: normalizedText, anchorNumbers: pendingAnchors }
        : { text: normalizedText };

      segments.push(entry);
      segmentText = "";
      pendingAnchors = [];
    };

    let match: RegExpExecArray | null;
    while ((match = COMPLETE_ANCHOR.exec(raw)) !== null) {
      const between = raw.slice(cursor, match.index);

      // If anchors were collected for the previous segment, any subsequent text begins a new segment.
      if (pendingAnchors.length > 0 && between.length > 0) {
        finalizeSegment();
      }

      segmentText += between;

      const number = Number(match[1] ?? "");
      if (Number.isFinite(number) && number >= 1 && number <= contexts.length) {
        pendingAnchors.push(number);
      }

      cursor = COMPLETE_ANCHOR.lastIndex;
    }

    const tail = raw.slice(cursor);
    if (pendingAnchors.length > 0 && tail.length > 0) {
      finalizeSegment();
    }

    segmentText += tail;
    finalizeSegment();

    // If no anchors were used, return a sanitized answer only (no heuristic placement fallback).
    const anyAnchors = segments.some((segment) => (segment.anchorNumbers?.length ?? 0) > 0);
    const answer = normalizeVisibleWhitespace(segments.map((segment) => segment.text).join(""));
    if (!anyAnchors) {
      return { answer };
    }

    const citationIndexByDocument = new Map<string, number>();
    const citations: ChatCitation[] = [];
    const answerSegments: AnswerSegment[] = [];

    segments.forEach((segment) => {
      const anchorNumbers = segment.anchorNumbers ?? [];
      if (anchorNumbers.length === 0) {
        answerSegments.push({ text: segment.text });
        return;
      }

      const indices: number[] = [];

      for (const anchorNumber of anchorNumbers) {
        const context = contexts[anchorNumber - 1];
        if (!context) {
          continue;
        }

        const existing = citationIndexByDocument.get(context.documentId);
        if (existing !== undefined) {
          indices.push(existing);
          continue;
        }

        const nextIndex = citations.length;
        citationIndexByDocument.set(context.documentId, nextIndex);
        citations.push({
          documentId: context.documentId,
          chunkId: context.chunkId,
          title: context.title,
        });
        indices.push(nextIndex);
      }

      const deduped = [...new Set(indices)].sort((a, b) => a - b);
      answerSegments.push(
        deduped.length > 0
          ? { text: segment.text, citationIndices: deduped }
          : { text: segment.text },
      );
    });

    return {
      answer,
      citations,
      answerSegments,
    };
  }
}

export const stripCitationAnchorsForDisplay = (text: string): string =>
  normalizeVisibleWhitespace(text ?? "");
