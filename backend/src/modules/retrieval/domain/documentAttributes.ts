/**
 * Facts a document states about itself at its top — front matter, or a
 * leading block of `Label: value` lines — lifted onto every chunk of the
 * document, so a chunk from deep in the text still carries them into search
 * and into the answer.
 *
 * Detection is structural only: front matter fences, list markers, emphasis,
 * the colon, blank lines, sentence punctuation and value length. It reads no
 * label vocabulary, so it works for any language.
 */
interface DocumentAttribute {
  readonly label: string;
  readonly value: string;
}

/**
 * Why a document did or did not yield attributes; bounded, for the worker's log.
 * Rejections name the structure that marked the opening as something other than
 * a block of facts about the document.
 */
type DocumentAttributesOutcome =
  | "none"
  | "extracted"
  | "rejected_single_entry"
  | "rejected_repeated_labels"
  | "rejected_sentence_values"
  | "rejected_prose_follows"
  | "rejected_message_headers"
  | "rejected_list_or_code";

/** The chunk-metadata key the attributes travel under. */
const DOCUMENT_ATTRIBUTES_METADATA_KEY = "documentAttributes";

export const DOCUMENT_ATTRIBUTE_LIMITS = {
  maxEntries: 24,
  maxLabelChars: 48,
  maxLabelWords: 6,
  /** A field, not a paragraph: a longer value ends the block. */
  maxValueChars: 160,
  /** Ceiling on the stored set, rendered; later entries are left off. */
  maxStoredChars: 1_200,
  /** How far into the document the leading block may reach. */
  maxScannedLines: 80,
  /** A lone labelled line is as likely a sentence ("Update: …") as an attribute. */
  minBlockEntries: 2,
  /** A value this short is a field; longer ones render after every short one. */
  shortValueChars: 40,
  /**
   * The most a chunk's embedded text gives the attributes, as a share of the chunk's own
   * length, so a short chunk is still mostly its own text to the embedding.
   */
  embeddedShareOfChunk: 0.3,
} as const;

const ATTRIBUTE_SEPARATOR = " | ";
const FRONT_MATTER_FENCE = /^---\s*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)\s*$/;
const FRONT_MATTER_KEY_VALUE = /^([^\s#:-][^:]*?):(?:\s+(.*))?$/u;
const FRONT_MATTER_BLOCK_INDICATOR = /^[|>&*!]/;
// Comments, indented nested lines, and the items of a sequence under a key.
const YAML_COMMENT_OR_NESTED_LINE = /^(?:#|\s|- )/;
const MARKDOWN_HEADING_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const THEMATIC_BREAK_LINE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const INDENTED_CODE_LINE = /^(?: {4}|\t)/;
const ORDERED_LIST_MARKER = /^\s*\d{1,3}[.)]\s+/;
const BULLET_MARKER = /^\s*[-*+]\s+/;
const EMPHASIS_WRAPPED_PREFIX = /^(\*\*|__|\*|_)(.+?)\1(.*)$/u;
const EMPHASIS_WRAPPED_VALUE = /^(\*\*|__|\*|_)(.+)\1$/u;
// Full-width colon included: CJK text labels with "：".
const LABEL_VALUE = /^([^:：]+?)\s*[:：]\s*(.*)$/u;
const HAS_LETTER = /\p{L}/u;
// Clause punctuation or markup in a label means the colon sits in prose. A full stop
// stays allowed: abbreviations ("Tel.", "Approx. size") end in one.
const NON_LABEL_CHARACTER = /[!?;,|<>[\]{}`"]|(?!\.)\p{Sentence_Terminal}/u;
const ENDS_WITH_SENTENCE_TERMINAL = /\p{Sentence_Terminal}["'”’)\]]*$/u;
// RFC 5322 angle-addr: a mailbox written the way message headers write it.
const ANGLE_ADDRESS = /<[^<>\s@]+@[^<>\s@]+>/u;
const EMAIL_ADDRESS = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/u;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]+/gu;

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

export const extractLeadingDocumentAttributes = (
  markdown: string,
): { attributes: DocumentAttribute[]; outcome: DocumentAttributesOutcome } => {
  const lines = markdown.split(/\r?\n/, DOCUMENT_ATTRIBUTE_LIMITS.maxScannedLines);
  const frontMatter = readFrontMatter(lines);
  const block = readLeadingBlock(lines, frontMatter.nextLine);
  const attributes = withinLimits([...frontMatter.attributes, ...block.attributes]);

  if (attributes.length > 0) {
    return { attributes, outcome: "extracted" };
  }
  return { attributes, outcome: block.outcome };
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

/** The chunk metadata without the document's own attributes, for prompts that read metadata as plain facts. */
export const withoutDocumentAttributes = (metadata: Record<string, unknown>): Record<string, unknown> =>
  DOCUMENT_ATTRIBUTES_METADATA_KEY in metadata
    ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== DOCUMENT_ATTRIBUTES_METADATA_KEY))
    : metadata;

/** How many characters of a chunk's embedded text its document's attributes may take. */
export const documentAttributeCharsForChunk = (chunkContent: string): number =>
  Math.floor(chunkContent.length * DOCUMENT_ATTRIBUTE_LIMITS.embeddedShareOfChunk);

/**
 * The attributes as delimited data — `Label: "value"`, the value quoted and escaped, so
 * neither a separator nor a quote inside it can pass for structure — as many whole
 * entries as fit `maxChars` once joined. Short field values made of words come first,
 * then other short values, then long ones, each group in document order.
 */
export const renderDocumentAttributes = (attributes: readonly DocumentAttribute[], maxChars: number): string[] => {
  const rendered: string[] = [];
  let usedChars = 0;
  for (const attribute of prioritized(attributes)) {
    const entry = renderAttribute(attribute);
    const entryChars = (rendered.length > 0 ? ATTRIBUTE_SEPARATOR.length : 0) + entry.length;
    if (usedChars + entryChars > maxChars) {
      continue;
    }
    rendered.push(entry);
    usedChars += entryChars;
  }
  return rendered;
};

const renderAttribute = ({ label, value }: DocumentAttribute): string =>
  `${normalizeWhitespace(label)}: ${JSON.stringify(normalizeWhitespace(value))}`;

const prioritized = (attributes: readonly DocumentAttribute[]): DocumentAttribute[] => {
  const tier = ({ value }: DocumentAttribute): number => {
    if (value.length > DOCUMENT_ATTRIBUTE_LIMITS.shortValueChars) {
      return 2;
    }
    return /\p{N}/u.test(value) ? 1 : 0;
  };
  return attributes
    .map((attribute, index) => ({ attribute, index, tier: tier(attribute) }))
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map(({ attribute }) => attribute);
};

const readFrontMatter = (lines: readonly string[]): { attributes: DocumentAttribute[]; nextLine: number } => {
  const none = { attributes: [], nextLine: 0 };
  if (!FRONT_MATTER_FENCE.test(lines[0] ?? "")) {
    return none;
  }
  const closingLine = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_CLOSE.test(line));
  if (closingLine < 0) {
    return none;
  }

  // A horizontal rule pair around ordinary text is not front matter: every line between
  // the fences has to read as YAML, and at least one as a top-level key.
  const body = lines.slice(1, closingLine).filter((line) => !isBlank(line));
  const keyLines = body.filter((line) => FRONT_MATTER_KEY_VALUE.test(line));
  if (keyLines.length === 0 || body.some((line) => !FRONT_MATTER_KEY_VALUE.test(line) && !YAML_COMMENT_OR_NESTED_LINE.test(line))) {
    return none;
  }

  const attributes = keyLines.flatMap((line): DocumentAttribute[] => {
    const match = FRONT_MATTER_KEY_VALUE.exec(line);
    const value = match?.[2]?.trim() ?? "";
    // An empty value opens a nested map or a list; an indicator opens a block scalar.
    if (!match || value.length === 0 || FRONT_MATTER_BLOCK_INDICATOR.test(value)) {
      return [];
    }
    const attribute = toAttribute(match[1] ?? "", unwrapYamlScalar(value));
    return attribute ? [attribute] : [];
  });

  return { attributes, nextLine: closingLine + 1 };
};

const readLeadingBlock = (
  lines: readonly string[],
  firstLine: number,
): { attributes: DocumentAttribute[]; outcome: DocumentAttributesOutcome } => {
  const rejected = (outcome: DocumentAttributesOutcome) => ({ attributes: [], outcome });
  let index = firstLine;
  while (index < lines.length && isOpeningSeparator(lines[index] ?? "")) {
    index += 1;
  }
  const opening = lines[index] ?? "";
  if (ORDERED_LIST_MARKER.test(opening) || INDENTED_CODE_LINE.test(opening)) {
    return rejected(parseLabelledLine(opening) ? "rejected_list_or_code" : "none");
  }

  const entries: DocumentAttribute[] = [];
  let sentenceValueEndedBlock = false;
  let blankBefore = false;
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (isBlank(line)) {
      blankBefore = true;
      continue;
    }
    if (MARKDOWN_HEADING_LINE.test(line)) {
      break;
    }
    const parsed = parseLabelledLine(line);
    const attribute = parsed && isFieldValue(parsed.value) ? toAttribute(parsed.label, parsed.value) : null;
    if (attribute) {
      entries.push(attribute);
      blankBefore = false;
      continue;
    }
    // A line that still looks like part of the block (a list item, a labelled line whose
    // value runs into prose) ends it; prose straight after the labels means they opened
    // the body rather than describing the document.
    sentenceValueEndedBlock = parsed !== null;
    if (entries.length > 0 && !blankBefore && parsed === null && !BULLET_MARKER.test(line)) {
      return rejected("rejected_prose_follows");
    }
    break;
  }

  if (entries.length === 0) {
    return rejected(sentenceValueEndedBlock ? "rejected_sentence_values" : "none");
  }
  if (hasRepeatedLabels(entries)) {
    return rejected("rejected_repeated_labels");
  }
  if (looksLikeMessageHeaders(entries)) {
    return rejected("rejected_message_headers");
  }
  if (entries.length < DOCUMENT_ATTRIBUTE_LIMITS.minBlockEntries) {
    return rejected("rejected_single_entry");
  }
  return { attributes: entries, outcome: "extracted" };
};

const isOpeningSeparator = (line: string): boolean =>
  isBlank(line) || MARKDOWN_HEADING_LINE.test(line) || THEMATIC_BREAK_LINE.test(line);

const parseLabelledLine = (line: string): { label: string; value: string } | null => {
  let text = line.trim().replace(BULLET_MARKER, "").replace(ORDERED_LIST_MARKER, "");
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
  && label.split(/\s+/).length <= DOCUMENT_ATTRIBUTE_LIMITS.maxLabelWords
  && HAS_LETTER.test(label)
  && !NON_LABEL_CHARACTER.test(label);

/** A short field, not a sentence: a value of three or more words ending in sentence punctuation reads as prose. */
const isFieldValue = (value: string): boolean =>
  value.length <= DOCUMENT_ATTRIBUTE_LIMITS.maxValueChars
  && !(ENDS_WITH_SENTENCE_TERMINAL.test(value) && wordCount(value) >= 3);

const wordCount = (value: string): number => {
  let count = 0;
  for (const segment of WORD_SEGMENTER.segment(value)) {
    if (segment.isWordLike) {
      count += 1;
    }
  }
  return count;
};

/** The same label twice is a dialogue, an FAQ or a list of like items, never facts about one document. */
const hasRepeatedLabels = (entries: readonly DocumentAttribute[]): boolean =>
  new Set(entries.map((entry) => entry.label.toLocaleLowerCase())).size < entries.length;

/** Mailboxes written as message headers write them, or several addresses, mark an email's header block. */
const looksLikeMessageHeaders = (entries: readonly DocumentAttribute[]): boolean =>
  entries.some((entry) => ANGLE_ADDRESS.test(entry.value))
  || entries.filter((entry) => EMAIL_ADDRESS.test(entry.value)).length >= 2;

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
  let storedChars = 0;

  for (const entry of entries) {
    const key = entry.label.toLocaleLowerCase();
    if (seenLabels.has(key)) {
      continue;
    }
    const entryChars = (kept.length > 0 ? ATTRIBUTE_SEPARATOR.length : 0) + renderAttribute(entry).length;
    if (kept.length >= DOCUMENT_ATTRIBUTE_LIMITS.maxEntries || storedChars + entryChars > DOCUMENT_ATTRIBUTE_LIMITS.maxStoredChars) {
      break;
    }
    seenLabels.add(key);
    kept.push(entry);
    storedChars += entryChars;
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

const normalizeWhitespace = (value: string): string => value.replace(WHITESPACE_OR_CONTROL, " ").trim();
