const GENERIC_SUBJECT_PATTERNS = [
  /^\|.*\|$/,
  /^https?:\/\//i,
  /^(home|login|contact|contents?)$/i,
  /^(blog|article|archive|archives|events?)$/i,
];

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

const normalizeSubject = (value: string): string | null => {
  const normalized = normalizeWhitespace(
    value
      .replace(/^#+\s*/, "")
      .replace(/^subject:\s*/i, "")
      .replace(/[|]+/g, " ")
      .replace(/[()[\]{}]/g, " ")
      .replace(/\s+-\s+.+$/, ""),
  );

  if (normalized.length < 2) {
    return null;
  }

  if (GENERIC_SUBJECT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return null;
  }

  return normalized;
};

export const deriveDocumentSubject = (input: { title: string; content: string }): string | null => {
  const headingMatch = input.content.match(/^#{1,6}\s+(.+)$/m);
  if (headingMatch?.[1]) {
    const normalized = normalizeSubject(headingMatch[1]);
    if (normalized) {
      return normalized;
    }
  }

  const titleCandidate = normalizeSubject(input.title);
  if (titleCandidate) {
    return titleCandidate;
  }

  return null;
};

const SECTION_LABEL_SEPARATOR = " · ";
// The reranker reads only the first `rerank.maxRetrievalTextChars` characters of a chunk's search
// text, which opens with its title, subject and section lines. The label stops adding headings at
// this length, so that view still reaches the chunk's own text.
const SECTION_LABEL_MAX_CHARS = 80;

/** Every heading a chunk holds, in order, each once, as written: its punctuation kept. */
export const deriveChunkHeadings = (content: string): string[] => {
  const headings: string[] = [];
  for (const match of content.matchAll(/^#{1,6}[ \t]+(.+)$/gm)) {
    const heading = normalizeWhitespace(match[1] ?? "");
    if (heading && !headings.includes(heading)) {
      headings.push(heading);
    }
  }
  return headings;
};

const deriveChunkSubjects = (content: string): string[] => {
  const subjects: string[] = [];
  for (const heading of deriveChunkHeadings(content)) {
    const subject = normalizeSubject(heading);
    if (subject && !subjects.includes(subject)) {
      subjects.push(subject);
    }
  }
  return subjects;
};

/**
 * The section label of a chunk's search text: every heading the chunk holds, in order, so a chunk
 * that runs from one section into the next is found under each of them. A heading that would take
 * the label past its length cap is left out whole, along with every heading after it.
 */
export const deriveChunkSection = (content: string): string | null => {
  const headings: string[] = [];
  let labelLength = 0;
  for (const heading of deriveChunkSubjects(content)) {
    const nextLength = labelLength + (headings.length > 0 ? SECTION_LABEL_SEPARATOR.length : 0) + heading.length;
    if (headings.length > 0 && nextLength > SECTION_LABEL_MAX_CHARS) {
      break;
    }
    headings.push(heading);
    labelLength = nextLength;
  }
  return headings.length > 0 ? headings.join(SECTION_LABEL_SEPARATOR) : null;
};
