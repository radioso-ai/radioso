import type { LexicalQueryPlan, LexicalSearchOption, ResponseLanguagePolicy, RetrievalSubquery } from "./retrievalPipelineTypes.js";

const DEFAULT_MAX_ALTERNATIVES = 4;

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

  return markRelaxations(alternatives);
};

/** Words of a text as lexical search compares them: runs of letters, marks, and digits in any script, lowercased. */
export const lexicalTermsOf = (value: string): string[] => value.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

/** The distinct terms an alternative searches for, its phrases' words included. */
export const lexicalOptionTerms = (option: LexicalSearchOption): string[] => [
  ...new Set(lexicalTermsOf([...option.phrases, ...option.requiredTerms].join(" "))),
];

/**
 * Marks each alternative whose terms are a strict part of a sibling's as a relaxation of the sibling
 * with the fewest terms that holds them: `Planet` beside `Planet plan`.
 */
const markRelaxations = (options: LexicalSearchOption[]): LexicalSearchOption[] => {
  const terms = options.map((option) => new Set(lexicalOptionTerms(option)));
  return options.map((option, index) => {
    const own = terms[index] ?? new Set<string>();
    const [closest] = terms
      .filter((sibling) => sibling.size > own.size && [...own].every((term) => sibling.has(term)))
      .sort((left, right) => left.size - right.size);
    return closest && own.size > 0 ? { ...option, relaxationOf: [...closest] } : option;
  });
};

/** Whether a subquery searches a relaxation of a sibling subquery's alternative alone. */
export const isLexicalRelaxation = (subquery: Pick<RetrievalSubquery, "lexicalPlan">): boolean => {
  const options = subquery.lexicalPlan?.options ?? [];
  return options.length === 1 && Boolean(options[0]?.relaxationOf);
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
    lexicalPlan: { options: [alternative] },
  }));
};

/**
 * Splits each subquery's top-level OR into one subquery per alternative, sharing its semantic query,
 * so every alternative runs as an all-terms search of its own rather than as the word "or". When
 * the alternatives outnumber `maxBranches`, relaxations give way first: every subquery's own search
 * is kept before any relaxation is. If that is not enough, the latest subqueries' alternatives
 * share one search each, which a chunk matches by holding any of them, so no subquery goes
 * unsearched. A shared search never holds a relaxation: beside its phrase in one search, the bare
 * name's passing mentions would count as full matches.
 */
export const expandLexicalAlternatives = (subqueries: RetrievalSubquery[], maxBranches: number): RetrievalSubquery[] => {
  const searchCount = (alternatives: LexicalSearchOption[]): number => Math.max(1, alternatives.length);
  const groups = subqueries.map((subquery) => ({ subquery, alternatives: deriveLexicalOptions(subquery.lexicalQuery) }));
  let relaxationRoom = maxBranches - groups.reduce(
    (count, group) => count + searchCount(group.alternatives.filter((alternative) => !alternative.relaxationOf)),
    0,
  );
  const kept = groups.map((group) => ({
    ...group,
    shared: false,
    alternatives: group.alternatives.filter((alternative) => {
      if (!alternative.relaxationOf) {
        return true;
      }
      relaxationRoom -= 1;
      return relaxationRoom >= 0;
    }),
  }));
  let branchCount = kept.reduce((count, group) => count + searchCount(group.alternatives), 0);
  for (const group of [...kept].reverse()) {
    if (branchCount <= maxBranches) {
      break;
    }
    if (group.alternatives.length > 1) {
      branchCount -= group.alternatives.length - 1;
      group.shared = true;
    }
  }
  const branches = kept.flatMap(({ subquery, alternatives, shared }, index): RetrievalSubquery[] => {
    if ((groups[index]?.alternatives.length ?? 0) <= 1) {
      return [subquery];
    }
    if (shared) {
      return [{ ...subquery, lexicalPlan: { options: alternatives.filter((alternative) => !alternative.relaxationOf) } }];
    }
    // Each alternative keeps the subquery's label: they search for the one thing it names.
    return alternatives.map((alternative) => ({
      ...subquery,
      lexicalQuery: alternative.lexicalQuery,
      lexicalPlan: { options: [alternative] },
    }));
  });
  return branches.slice(0, maxBranches).map((branch, index) => ({ ...branch, id: `subquery_${index + 1}` }));
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
