const DIRECT_ANSWER_PATTERNS = [
  /\bjust the answer\b/i,
  /\bjust answer\b/i,
  /\bbriefly\b/i,
  /\bbe brief\b/i,
  /\bshort answer\b/i,
  /\bone sentence\b/i,
  /\bconcise\b/i,
  /\bsuccinct\b/i,
  /\bno follow[- ]up\b/i,
  /\bwithout extra detail/i,
  /\bsolo la risposta\b/i,
  /\bin breve\b/i,
];

export const shouldSuppressOptionalSuggestions = (query: string): boolean =>
  DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(query));
