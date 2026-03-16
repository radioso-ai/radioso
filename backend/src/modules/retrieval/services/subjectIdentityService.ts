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

export const deriveChunkSection = (content: string): string | null => {
  const headingMatch = content.match(/^#{1,6}\s+(.+)$/m);
  return headingMatch?.[1] ? normalizeSubject(headingMatch[1]) : null;
};
