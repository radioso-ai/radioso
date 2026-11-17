/**
 * Facts a document states about itself at its top — front matter, or a
 * leading block of `Label: value` lines — lifted onto every chunk of the
 * document, so a chunk from deep in the text still carries them into search
 * and into the answer.
 *
 * Detection is structural only: front matter fences, list markers, emphasis
 * and the colon. It reads no label vocabulary, so it works for any language.
 */
interface DocumentAttribute {
  readonly label: string;
  readonly value: string;
}

/** The chunk-metadata key the attributes travel under. */
const DOCUMENT_ATTRIBUTES_METADATA_KEY = "documentAttributes";

export const DOCUMENT_ATTRIBUTE_LIMITS = {
  maxEntries: 24,
  maxLabelChars: 48,
  maxValueChars: 240,
  /** Ceiling on `renderDocumentAttributes`' output; later entries are left off. */
  maxRenderedChars: 1_200,
  /** How far into the document the leading block may reach. */
  maxScannedLines: 80,
  /** A lone labelled line is as likely a sentence ("Update: …") as an attribute. */
  minBlockEntries: 2,
} as const;

const ATTRIBUTE_SEPARATOR = " | ";
const FRONT_MATTER_FENCE = /^---\s*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)\s*$/;
const FRONT_MATTER_KEY_VALUE = /^([^\s#:][^:]*?):(?:\s+(.*))?$/u;
const FRONT_MATTER_BLOCK_INDICATOR = /^[|>&*!]/;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const LIST_MARKER = /^(?:[-*+]|\d{1,3}[.)])\s+/;
const EMPHASIS_WRAPPED_PREFIX = /^(\*\*|__|\*|_)(.+?)\1(.*)$/u;
const EMPHASIS_WRAPPED_VALUE = /^(\*\*|__|\*|_)(.+)\1$/u;
// Full-width colon included: CJK text labels with "：".
const LABEL_VALUE = /^([^:：]+?)\s*[:：]\s*(.*)$/u;
const HAS_LETTER = /\p{L}/u;
// Sentence punctuation or markup in a label means the colon sits in prose, not after a label.
const NON_LABEL_CHARACTER = /[.!?;,|<>[\]{}()`"]|\p{Sentence_Terminal}/u;

export const extractLeadingDocumentAttributes = (markdown: string): DocumentAttribute[] => {
  const lines = markdown.split(/\r?\n/, DOCUMENT_ATTRIBUTE_LIMITS.maxScannedLines);
  const frontMatter = readFrontMatter(lines);
  const leadingBlock = readLeadingBlock(lines, frontMatter.nextLine);
  const entries = [
    ...frontMatter.attributes,
    ...(leadingBlock.length >= DOCUMENT_ATTRIBUTE_LIMITS.minBlockEntries ? leadingBlock : []),
  ];

  return withinLimits(entries);
};

export const readDocumentAttributes = (metadata: Record<string, unknown> | undefined): DocumentAttribute[] => {
  const raw = metadata?.[DOCUMENT_ATTRIBUTES_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry: unknown): DocumentAttribute[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const { label, value } = entry as { label?: unknown; value?: unknown };
    return typeof label === "string" && typeof value === "string" && label.length > 0 && value.length > 0
      ? [{ label, value }]
      : [];
  });
};

/** The chunk metadata with the document's attributes added; unchanged when there are none. */
export const withDocumentAttributes = (
  metadata: Record<string, unknown>,
  attributes: readonly DocumentAttribute[],
): Record<string, unknown> =>
  attributes.length === 0
    ? metadata
    : { ...metadata, [DOCUMENT_ATTRIBUTES_METADATA_KEY]: attributes.map(({ label, value }) => ({ label, value })) };

export const renderDocumentAttributes = (attributes: readonly DocumentAttribute[]): string[] =>
  attributes.map(renderAttribute);

const renderAttribute = ({ label, value }: DocumentAttribute): string => `${label}: ${value}`;

const readFrontMatter = (lines: readonly string[]): { attributes: DocumentAttribute[]; nextLine: number } => {
  if (!FRONT_MATTER_FENCE.test(lines[0] ?? "")) {
    return { attributes: [], nextLine: 0 };
  }
  const closingLine = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_CLOSE.test(line));
  if (closingLine < 0) {
    return { attributes: [], nextLine: 0 };
  }

  const attributes = lines.slice(1, closingLine).flatMap((line): DocumentAttribute[] => {
    // Indented lines belong to a nested map, a list or a block scalar.
    const match = FRONT_MATTER_KEY_VALUE.exec(line);
    const value = match?.[2]?.trim() ?? "";
    if (!match || value.length === 0 || FRONT_MATTER_BLOCK_INDICATOR.test(value)) {
      return [];
    }
    const attribute = toAttribute(match[1] ?? "", unwrapYamlScalar(value));
    return attribute ? [attribute] : [];
  });

  return { attributes, nextLine: closingLine + 1 };
};

const readLeadingBlock = (lines: readonly string[], firstLine: number): DocumentAttribute[] => {
  let index = firstLine;
  while (index < lines.length && (isBlank(lines[index]) || MARKDOWN_HEADING_LINE.test(lines[index] ?? ""))) {
    index += 1;
  }

  const attributes: DocumentAttribute[] = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isBlank(line)) {
      continue;
    }
    const parsed = MARKDOWN_HEADING_LINE.test(line) ? null : parseLabelledLine(line);
    if (parsed === null) {
      break;
    }
    // A labelled line whose value is too long for an attribute still belongs to the block.
    const attribute = toAttribute(parsed.label, parsed.value);
    if (attribute) {
      attributes.push(attribute);
    }
  }
  return attributes;
};

const parseLabelledLine = (line: string): { label: string; value: string } | null => {
  let text = line.trim().replace(LIST_MARKER, "");
  const emphasised = EMPHASIS_WRAPPED_PREFIX.exec(text);
  if (emphasised) {
    text = `${emphasised[2] ?? ""}${emphasised[3] ?? ""}`;
  }
  const match = LABEL_VALUE.exec(text);
  if (!match) {
    return null;
  }
  const label = (match[1] ?? "").trim();
  const value = unwrapEmphasis((match[2] ?? "").trim());
  if (!isLabel(label) || value.length === 0 || value.startsWith("//")) {
    return null;
  }
  return { label, value };
};

const isLabel = (label: string): boolean =>
  label.length > 0
  && label.length <= DOCUMENT_ATTRIBUTE_LIMITS.maxLabelChars
  && HAS_LETTER.test(label)
  && !NON_LABEL_CHARACTER.test(label);

const toAttribute = (rawLabel: string, rawValue: string): DocumentAttribute | null => {
  const label = normalizeWhitespace(rawLabel);
  const value = normalizeWhitespace(rawValue);
  if (!isLabel(label) || value.length === 0 || value.length > DOCUMENT_ATTRIBUTE_LIMITS.maxValueChars) {
    return null;
  }
  return { label, value };
};

const withinLimits = (entries: readonly DocumentAttribute[]): DocumentAttribute[] => {
  const seenLabels = new Set<string>();
  const kept: DocumentAttribute[] = [];
  let renderedChars = 0;

  for (const entry of entries) {
    const key = entry.label.toLocaleLowerCase();
    if (seenLabels.has(key)) {
      continue;
    }
    const entryChars = (kept.length > 0 ? ATTRIBUTE_SEPARATOR.length : 0) + renderAttribute(entry).length;
    if (kept.length >= DOCUMENT_ATTRIBUTE_LIMITS.maxEntries || renderedChars + entryChars > DOCUMENT_ATTRIBUTE_LIMITS.maxRenderedChars) {
      break;
    }
    seenLabels.add(key);
    kept.push(entry);
    renderedChars += entryChars;
  }
  return kept;
};

const unwrapYamlScalar = (value: string): string => {
  const quoted = /^(["'])(.*)\1$/u.exec(value);
  if (quoted) {
    return quoted[2] ?? "";
  }
  const flowSequence = /^\[(.*)\]$/u.exec(value);
  return flowSequence ? (flowSequence[1] ?? "").split(",").map((item) => item.trim()).filter(Boolean).join(", ") : value;
};

const unwrapEmphasis = (value: string): string => EMPHASIS_WRAPPED_VALUE.exec(value)?.[2]?.trim() ?? value;

const isBlank = (line: string | undefined): boolean => (line ?? "").trim().length === 0;

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
