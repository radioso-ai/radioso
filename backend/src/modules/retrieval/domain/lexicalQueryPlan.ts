import type { ResponseLanguagePolicy, RetrievalSubquery } from "./retrievalPipelineTypes.js";

const DEFAULT_MAX_ALTERNATIVES = 4;

export interface LexicalSearchOption {
  label: string;
  lexicalQuery: string;
  phrases: string[];
  requiredTerms: string[];
  excludedTerms: string[];
}

export interface LexicalQueryPlan {
  options: LexicalSearchOption[];
}

export const deriveLexicalQueryPlan = (
  lexicalQuery: string,
  options: { maxAlternatives?: number } = {},
): LexicalQueryPlan => ({
  options: deriveLexicalOptions(lexicalQuery, options),
});

export const buildPlainLexicalQueryPlan = (lexicalQuery: string): LexicalQueryPlan => {
  const normalizedQuery = normalizeLexicalQuery(lexicalQuery);
  if (!hasSearchableContent(normalizedQuery)) {
    return { options: [] };
  }

  return {
    options: [
      {
        label: normalizedQuery,
        lexicalQuery: normalizedQuery,
        phrases: [],
        requiredTerms: [normalizedQuery],
        excludedTerms: [],
      },
    ],
  };
};

export const deriveLexicalAlternatives = (
  lexicalQuery: string,
  options: { maxAlternatives?: number } = {},
): string[] => deriveLexicalOptions(lexicalQuery, options).map((alternative) => alternative.lexicalQuery);

const deriveLexicalOptions = (
  lexicalQuery: string,
  options: { maxAlternatives?: number } = {},
): LexicalSearchOption[] => {
  const maxAlternatives = Math.max(1, options.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES);
  const rawAlternatives = splitTopLevelOr(lexicalQuery);
  const seen = new Set<string>();
  const alternatives: LexicalSearchOption[] = [];

  for (const rawAlternative of rawAlternatives) {
    const alternative = buildLexicalSearchOption(rawAlternative);
    if (!hasSearchableContent(alternative.lexicalQuery)) {
      continue;
    }

    const key = alternative.label.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    alternatives.push(alternative);
    if (alternatives.length >= maxAlternatives) {
      break;
    }
  }

  return alternatives;
};

export const buildLexicalAlternativeSubqueries = (input: {
  semanticQuery: string;
  lexicalQuery: string;
  responseLanguagePolicy: ResponseLanguagePolicy;
  maxAlternatives?: number;
}): RetrievalSubquery[] | undefined => {
  const alternatives = deriveLexicalOptions(input.lexicalQuery, {
    maxAlternatives: input.maxAlternatives,
  });

  if (alternatives.length <= 1) {
    return undefined;
  }

  return alternatives.map((alternative, index) => ({
    id: `subquery_${index + 1}`,
    label: alternative.label,
    semanticQuery: input.semanticQuery,
    lexicalQuery: alternative.lexicalQuery,
    reason: "lexical_alternative",
    responseLanguagePolicy: input.responseLanguagePolicy,
  }));
};

const splitTopLevelOr = (value: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let inQuote: '"' | "'" | null = null;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      inQuote = inQuote === char ? null : inQuote ?? char;
      current += char;
      continue;
    }

    if (!inQuote && isOrOperatorAt(value, index)) {
      parts.push(current);
      current = "";
      index += 1;
      continue;
    }

    current += char;
  }

  parts.push(current);
  return parts.length > 1 ? parts : [value];
};

const isOrOperatorAt = (value: string, index: number): boolean => {
  if (value.slice(index, index + 2) !== "OR") {
    return false;
  }

  const before = value[index - 1] ?? " ";
  const after = value[index + 2] ?? " ";
  return /\s|\(|\|/.test(before) && /\s|\)|\|/.test(after);
};

const buildLexicalSearchOption = (value: string): LexicalSearchOption => {
  const lexicalQuery = normalizeLexicalQuery(value);
  const label = lexicalQuery.replace(/["']/g, "").replace(/\s+/g, " ").trim();

  return {
    label,
    lexicalQuery,
    phrases: extractQuotedPhrases(lexicalQuery),
    requiredTerms: extractRequiredTerms(lexicalQuery),
    excludedTerms: extractExcludedTerms(lexicalQuery),
  };
};

const normalizeLexicalQuery = (value: string): string => value.trim().replace(/\s+/g, " ").trim();

const hasSearchableContent = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);

const extractQuotedPhrases = (value: string): string[] => {
  const phrases: string[] = [];
  const phrasePattern = /"([^"]+)"|'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = phrasePattern.exec(value)) !== null) {
    const phrase = (match[1] ?? match[2] ?? "").trim();
    if (phrase) {
      phrases.push(phrase);
    }
  }

  return phrases;
};

const extractRequiredTerms = (value: string): string[] =>
  removeQuotedPhrases(value)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !term.startsWith("-") && term.toUpperCase() !== "OR");

const extractExcludedTerms = (value: string): string[] =>
  removeQuotedPhrases(value)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.startsWith("-") && term.length > 1)
    .map((term) => term.slice(1));

const removeQuotedPhrases = (value: string): string => value.replace(/"[^"]+"|'[^']+'/g, " ");
