import type { ResponseLanguagePolicy, RetrievalSubquery } from "./retrievalPipelineTypes.js";

const DEFAULT_MAX_ALTERNATIVES = 4;

export const deriveLexicalAlternatives = (
  lexicalQuery: string,
  options: { maxAlternatives?: number } = {},
): string[] => {
  const maxAlternatives = Math.max(1, options.maxAlternatives ?? DEFAULT_MAX_ALTERNATIVES);
  const rawAlternatives = splitTopLevelOr(lexicalQuery);
  const seen = new Set<string>();
  const alternatives: string[] = [];

  for (const rawAlternative of rawAlternatives) {
    const alternative = normalizeLexicalAlternative(rawAlternative);
    if (!hasSearchableContent(alternative)) {
      continue;
    }

    const key = alternative.toLocaleLowerCase();
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
  const alternatives = deriveLexicalAlternatives(input.lexicalQuery, {
    maxAlternatives: input.maxAlternatives,
  });

  if (alternatives.length <= 1) {
    return undefined;
  }

  return alternatives.map((alternative, index) => ({
    id: `subquery_${index + 1}`,
    label: alternative,
    semanticQuery: input.semanticQuery,
    lexicalQuery: alternative,
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

const normalizeLexicalAlternative = (value: string): string =>
  value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const hasSearchableContent = (value: string): boolean => /[\p{L}\p{N}]/u.test(value);
