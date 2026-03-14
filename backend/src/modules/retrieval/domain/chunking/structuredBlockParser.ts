import { normalizeMarkdown } from "./chunkingStrategy.js";

export type StructuralBlockKind =
  | "heading"
  | "paragraph"
  | "bullet_list"
  | "ordered_list"
  | "table"
  | "code_fence"
  | "faq_pair";

export interface StructuralBlock {
  kind: StructuralBlockKind;
  content: string;
  startOffset: number;
  endOffset: number;
  tokenCount: number;
}

interface LineRecord {
  text: string;
  start: number;
  end: number;
}

export const parseStructuralBlocks = (content: string): StructuralBlock[] => {
  const normalized = normalizeMarkdown(content);

  if (normalized.length === 0) {
    return [];
  }

  const lines = splitLines(normalized);
  const blocks: StructuralBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line || isBlank(line.text)) {
      index += 1;
      continue;
    }

    if (isFenceLine(line.text)) {
      const endIndex = findFenceEnd(lines, index);
      blocks.push(buildBlock(normalized, "code_fence", lines[index].start, lines[endIndex].end));
      index = endIndex + 1;
      continue;
    }

    if (isHeadingLine(line.text)) {
      blocks.push(buildBlock(normalized, "heading", line.start, line.end));
      index += 1;
      continue;
    }

    if (isTableHeader(lines, index)) {
      let endIndex = index + 1;
      while (endIndex + 1 < lines.length && isTableRow(lines[endIndex + 1]?.text ?? "")) {
        endIndex += 1;
      }
      blocks.push(buildBlock(normalized, "table", line.start, lines[endIndex].end));
      index = endIndex + 1;
      continue;
    }

    if (isBulletListItem(line.text)) {
      const endIndex = collectList(lines, index, isBulletListItem);
      blocks.push(buildBlock(normalized, "bullet_list", line.start, lines[endIndex].end));
      index = endIndex + 1;
      continue;
    }

    if (isOrderedListItem(line.text)) {
      const endIndex = collectList(lines, index, isOrderedListItem);
      blocks.push(buildBlock(normalized, "ordered_list", line.start, lines[endIndex].end));
      index = endIndex + 1;
      continue;
    }

    const endIndex = collectParagraph(lines, index);
    blocks.push(buildBlock(normalized, "paragraph", line.start, lines[endIndex].end));
    index = endIndex + 1;
  }

  return combineFaqPairs(normalized, blocks);
};

const splitLines = (content: string): LineRecord[] => {
  const lines: LineRecord[] = [];
  let start = 0;

  for (let index = 0; index <= content.length; index += 1) {
    if (index === content.length || content[index] === "\n") {
      lines.push({
        text: content.slice(start, index),
        start,
        end: index,
      });
      start = index + 1;
    }
  }

  return lines;
};

const buildBlock = (
  content: string,
  kind: StructuralBlockKind,
  rawStartOffset: number,
  rawEndOffset: number,
): StructuralBlock => {
  const { startOffset, endOffset } = trimRange(content, rawStartOffset, rawEndOffset);
  const blockContent = content.slice(startOffset, endOffset);

  return {
    kind,
    content: blockContent,
    startOffset,
    endOffset,
    tokenCount: estimateTokenCount(blockContent),
  };
};

const trimRange = (content: string, startOffset: number, endOffset: number): { startOffset: number; endOffset: number } => {
  let start = startOffset;
  let end = endOffset;

  while (start < end && /\s/.test(content[start] ?? "")) {
    start += 1;
  }
  while (end > start && /\s/.test(content[end - 1] ?? "")) {
    end -= 1;
  }

  return { startOffset: start, endOffset: end };
};

const combineFaqPairs = (content: string, blocks: StructuralBlock[]): StructuralBlock[] => {
  const combined: StructuralBlock[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const current = blocks[index];
    const next = blocks[index + 1];

    if (
      current?.kind === "paragraph" &&
      next?.kind === "paragraph" &&
      current.content.trim().endsWith("?")
    ) {
      combined.push(buildBlock(content, "faq_pair", current.startOffset, next.endOffset));
      index += 1;
      continue;
    }

    if (current) {
      combined.push(current);
    }
  }

  return combined;
};

const collectList = (lines: LineRecord[], startIndex: number, matcher: (value: string) => boolean): number => {
  let index = startIndex;

  while (index + 1 < lines.length) {
    const nextLine = lines[index + 1];
    if (!nextLine || isBlank(nextLine.text) || !matcher(nextLine.text)) {
      break;
    }
    index += 1;
  }

  return index;
};

const collectParagraph = (lines: LineRecord[], startIndex: number): number => {
  let index = startIndex;

  while (index + 1 < lines.length) {
    const nextLine = lines[index + 1];

    if (!nextLine || isBlank(nextLine.text)) {
      break;
    }
    if (
      isFenceLine(nextLine.text) ||
      isHeadingLine(nextLine.text) ||
      isBulletListItem(nextLine.text) ||
      isOrderedListItem(nextLine.text) ||
      isTableHeader(lines, index + 1)
    ) {
      break;
    }

    index += 1;
  }

  return index;
};

const findFenceEnd = (lines: LineRecord[], startIndex: number): number => {
  const opener = lines[startIndex]?.text.trim().slice(0, 3);

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.text.trim().startsWith(opener ?? "")) {
      return index;
    }
  }

  return lines.length - 1;
};

const estimateTokenCount = (content: string): number => content.match(/\S+/g)?.length ?? 0;

const isBlank = (value: string): boolean => value.trim().length === 0;

const isFenceLine = (value: string): boolean => /^\s*(```|~~~)/.test(value);

const isHeadingLine = (value: string): boolean => /^\s{0,3}#{1,6}\s+\S/.test(value);

const isBulletListItem = (value: string): boolean => /^\s{0,3}[-+*]\s+\S/.test(value);

const isOrderedListItem = (value: string): boolean => /^\s{0,3}\d+[.)]\s+\S/.test(value);

const isTableHeader = (lines: LineRecord[], index: number): boolean =>
  isTableRow(lines[index]?.text ?? "") && isTableDelimiter(lines[index + 1]?.text ?? "");

const isTableRow = (value: string): boolean => value.includes("|");

const isTableDelimiter = (value: string): boolean => /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(value);
