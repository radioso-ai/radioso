const BREVITY_PATTERNS = [
  /\bjust the answer\b/i,
  /\bjust answer\b/i,
  /\bbrief(?:ly)?\b/i,
  /\bconcise(?:ly)?\b/i,
  /\bshort answer\b/i,
  /\bone sentence\b/i,
  /\bdirect answer\b/i,
  /\bno extra detail\b/i,
  /\bno follow[- ]?up\b/i,
];

export const isBrevityOverrideRequested = (query: string): boolean =>
  BREVITY_PATTERNS.some((pattern) => pattern.test(query));

