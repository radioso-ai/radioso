const MAX_PREVIEW_LINE_LENGTH = 200;

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  quot: "\"",
  nbsp: " ",
  mdash: "-",
  ndash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: "\"",
  ldquo: "\"",
  hellip: "...",
};

const normalizeInlineWhitespace = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n");

const decodeHtmlEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, rawEntity: string) => {
    const entity = rawEntity.toLowerCase();

    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return NAMED_HTML_ENTITIES[entity] ?? match;
  });

const normalizeForComparison = (value: string): string =>
  decodeHtmlEntities(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\b-\s+[\p{L}\p{N}][\p{L}\p{N} .:'’"!?()/-]*$/u, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const isLikelyTagCloudLine = (value: string): boolean => {
  const tokens = value.trim().split(/\s+/);
  return tokens.length >= 3 && tokens.every((token) => /^#[\p{L}\p{N}_-]+$/u.test(token));
};

const isLikelyTimecodeLine = (value: string): boolean => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(value.trim());
const isHeadingLine = (value: string): boolean => /^\s{0,3}#{1,6}\s+\S/u.test(value.trim());

const isNoiseLine = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  return isLikelyTagCloudLine(trimmed) || isLikelyTimecodeLine(trimmed);
};

const isLikelyTitleHeading = (line: string, title: string): boolean => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#")) {
    return false;
  }

  const headingText = trimmed.replace(/^#+\s*/, "");
  const normalizedHeading = normalizeForComparison(headingText);
  const normalizedTitle = normalizeForComparison(title);

  return normalizedHeading.length > 0 &&
    normalizedTitle.length > 0 &&
    (normalizedTitle.includes(normalizedHeading) || normalizedHeading.includes(normalizedTitle));
};

const trimBlankEdges = (lines: string[]): string[] => {
  let start = 0;
  let end = lines.length;

  while (start < end && lines[start]?.trim().length === 0) {
    start += 1;
  }

  while (end > start && lines[end - 1]?.trim().length === 0) {
    end -= 1;
  }

  return lines.slice(start, end);
};

const collapseBlankRuns = (lines: string[]): string[] => {
  const collapsed: string[] = [];

  for (const line of lines) {
    if (line.trim().length === 0 && collapsed.at(-1)?.trim().length === 0) {
      continue;
    }
    collapsed.push(line);
  }

  return trimBlankEdges(collapsed);
};

const cropAroundMatchedTitle = (lines: string[], title: string): string[] => {
  const titleIndex = lines.findIndex((line) => isLikelyTitleHeading(line, title));
  if (titleIndex === -1) {
    return lines;
  }

  return lines.slice(titleIndex);
};

const trimTrailingChrome = (lines: string[]): string[] => {
  let lastContentIndex = -1;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed || isNoiseLine(trimmed) || isHeadingLine(trimmed)) {
      continue;
    }

    lastContentIndex = index;
    break;
  }

  return lastContentIndex === -1 ? lines : lines.slice(0, lastContentIndex + 1);
};

export const sanitizeInlineDocumentContent = (input: {
  title: string;
  sourceContent: string;
  markdownContent?: string;
  metadata?: Record<string, unknown>;
}): { sourceContent: string; markdownContent: string } => {
  const markdown = input.markdownContent ?? input.sourceContent;
  const hasSourceUrl =
    typeof input.metadata?.sourceUrl === "string" && input.metadata.sourceUrl.trim().length > 0;

  const normalizedSource = decodeHtmlEntities(normalizeInlineWhitespace(input.sourceContent)).trim();
  const normalizedMarkdown = decodeHtmlEntities(normalizeInlineWhitespace(markdown)).trim();

  if (!hasSourceUrl) {
    return {
      sourceContent: normalizedSource,
      markdownContent: normalizedMarkdown,
    };
  }

  const croppedLines = cropAroundMatchedTitle(normalizedMarkdown.split("\n"), input.title)
    .map((line) => line.slice(0, MAX_PREVIEW_LINE_LENGTH * 20))
    .filter((line) => !isNoiseLine(line));
  const cleanedLines = collapseBlankRuns(trimTrailingChrome(croppedLines));
  const cleanedMarkdown = cleanedLines.join("\n").trim();

  if (!cleanedMarkdown) {
    return {
      sourceContent: normalizedSource,
      markdownContent: normalizedMarkdown,
    };
  }

  return {
    sourceContent: cleanedMarkdown,
    markdownContent: cleanedMarkdown,
  };
};
