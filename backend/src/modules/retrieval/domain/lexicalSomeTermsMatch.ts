import type { LexicalQueryPlan } from "./retrievalPipelineTypes.js";

export type LexicalTermAlternativeKind = "terms" | "phrase";

/**
 * One text a some-terms search looks for: a query term, two adjacent terms written as
 * one word ("super coscienti" also looks for "supercoscienti"), or a quoted phrase.
 * `text` is built only from letter and number runs, so it carries no search syntax; the
 * search adapter still hands it to Postgres as plain text.
 */
export interface LexicalTermAlternative {
  text: string;
  kind: LexicalTermAlternativeKind;
  /** Indexes of the query terms a chunk holding this alternative covers. */
  covers: number[];
}

/**
 * The terms of one lexical query and the alternatives that match them. The first
 * `termCount` alternatives search each term's own text, in term order; joins follow.
 */
export interface SomeTermsLexicalQuery {
  termCount: number;
  alternatives: LexicalTermAlternative[];
  excludedTerms: string[];
}

/**
 * A raw question can run long; past this many terms the extra words add search cost
 * faster than they add evidence.
 */
const MAX_SOME_TERMS_QUERY_TERMS = 12;

// Letter, mark, and number runs, kept whole across inner dots and underscores so
// "1.5" and "config_file" stay one term. Everything else — spaces, apostrophes,
// hyphens, and every tsquery operator — separates terms.
const TERM_PATTERN = /[\p{L}\p{M}\p{N}]+(?:[._][\p{L}\p{M}\p{N}]+)*/gu;
const PLAIN_WORD_PATTERN = /^[\p{L}\p{M}\p{N}]+$/u;

const termsOf = (value: string): string[] => value.match(TERM_PATTERN) ?? [];

const termKey = (value: string): string => value.toLowerCase();

/**
 * Builds the some-terms form of a single-option lexical plan, or `null` when there is
 * nothing to relax: one term matches the same chunks either way, and a plan that already
 * lists explicit alternatives keeps its own options.
 */
export const buildSomeTermsLexicalQuery = (plan: LexicalQueryPlan): SomeTermsLexicalQuery | null => {
  if (plan.options.length !== 1) {
    return null;
  }
  const [option] = plan.options;
  if (!option) {
    return null;
  }

  const alternatives: LexicalTermAlternative[] = [];
  const alternativeByKey = new Map<string, LexicalTermAlternative>();
  const addAlternative = (text: string, kind: LexicalTermAlternativeKind, covers: number[]) => {
    const key = `${kind}:${termKey(text)}`;
    const existing = alternativeByKey.get(key);
    if (existing) {
      existing.covers = [...new Set([...existing.covers, ...covers])].sort((left, right) => left - right);
      return;
    }
    const alternative = { text, kind, covers };
    alternativeByKey.set(key, alternative);
    alternatives.push(alternative);
  };

  let termCount = 0;
  const termIndexByKey = new Map<string, number>();
  for (const phrase of option.phrases) {
    const words = termsOf(phrase);
    if (termCount >= MAX_SOME_TERMS_QUERY_TERMS || words.length === 0) {
      continue;
    }
    const text = words.join(" ");
    const kind = words.length > 1 ? "phrase" : "terms";
    if (alternativeByKey.has(`${kind}:${termKey(text)}`)) {
      continue;
    }
    if (kind === "terms") {
      termIndexByKey.set(termKey(text), termCount);
    }
    addAlternative(text, kind, [termCount]);
    termCount += 1;
  }

  const sequence: Array<{ text: string; termIndex: number }> = [];
  for (const word of option.requiredTerms.flatMap(termsOf)) {
    const key = termKey(word);
    let termIndex = termIndexByKey.get(key);
    if (termIndex === undefined) {
      if (termCount >= MAX_SOME_TERMS_QUERY_TERMS) {
        continue;
      }
      termIndex = termCount;
      termIndexByKey.set(key, termIndex);
      addAlternative(word, "terms", [termIndex]);
      termCount += 1;
    }
    sequence.push({ text: word, termIndex });
  }

  if (termCount < 2) {
    return null;
  }

  for (let index = 1; index < sequence.length; index += 1) {
    const left = sequence[index - 1];
    const right = sequence[index];
    if (
      !left
      || !right
      || left.termIndex === right.termIndex
      || !PLAIN_WORD_PATTERN.test(left.text)
      || !PLAIN_WORD_PATTERN.test(right.text)
    ) {
      continue;
    }
    addAlternative(`${left.text}${right.text}`, "terms", [left.termIndex, right.termIndex]);
  }

  return {
    termCount,
    alternatives,
    excludedTerms: option.excludedTerms.flatMap(termsOf),
  };
};

/**
 * How the adapter ranks some-terms matches. Rarer terms carry more weight, measured
 * against the query's own most common term, so the ranking needs no list of words to
 * ignore in any language: a word that appears in most chunks weighs least wherever it
 * comes from.
 */
export interface SomeTermsRankingPlan {
  /** Alternatives whose matches make up the ranked chunk set, rarest first. */
  matchingAlternatives: number[];
  /** Weight of each query term, by term index. */
  termWeights: number[];
  totalWeight: number;
  /** A ranked chunk must hold at least this much term weight. */
  minimumCoveredWeight: number;
}

// The share floor is a ratio of sums of logarithms; this keeps a chunk that sits
// exactly on it from falling off through rounding.
const COVERED_WEIGHT_TOLERANCE = 1e-9;

export const planSomeTermsRanking = (input: {
  query: SomeTermsLexicalQuery;
  /** Chunks in scope that match each alternative, counted up to `matchCap + 1`. */
  alternativeMatchCounts: readonly number[];
  /** An alternative matching more chunks than this cannot find a chunk on its own. */
  matchCap: number;
  /** The most chunks the ranking reads, summed over the alternatives that define them. */
  rankedChunkBudget: number;
  /** The share of the query's term weight a ranked chunk must hold. */
  minimumWeightShare: number;
}): SomeTermsRankingPlan | null => {
  const countOf = (alternativeIndex: number): number =>
    Math.min(Math.max(input.alternativeMatchCounts[alternativeIndex] ?? 0, 0), input.matchCap + 1);

  const matchingAlternatives = selectMatchingAlternatives(input.query, countOf, input);
  if (matchingAlternatives.length === 0) {
    return null;
  }

  const termWeights = weighTerms(input.query.termCount, countOf);
  const totalWeight = termWeights.reduce((sum, weight) => sum + weight, 0);

  return {
    matchingAlternatives,
    termWeights,
    totalWeight,
    minimumCoveredWeight: totalWeight * input.minimumWeightShare * (1 - COVERED_WEIGHT_TOLERANCE),
  };
};

const selectMatchingAlternatives = (
  query: SomeTermsLexicalQuery,
  countOf: (alternativeIndex: number) => number,
  limits: { matchCap: number; rankedChunkBudget: number },
): number[] => {
  const candidates = query.alternatives
    .map((_, index) => ({ index, count: countOf(index) }))
    .filter((candidate) => candidate.count > 0 && candidate.count <= limits.matchCap)
    .sort((left, right) => left.count - right.count || left.index - right.index);

  const selected: number[] = [];
  let rankedChunks = 0;
  for (const candidate of candidates) {
    if (rankedChunks + candidate.count > limits.rankedChunkBudget) {
      break;
    }
    rankedChunks += candidate.count;
    selected.push(candidate.index);
  }
  return selected;
};

// Inverse document frequency against the query's most common term: that term weighs
// ln 2, a term found in a tenth as many chunks weighs ln 11. A term found nowhere is
// unknown rather than common, so it weighs as much as the rarest term that is found —
// a chunk then has to hold the query's specific words, not only its frequent ones.
const weighTerms = (termCount: number, countOf: (alternativeIndex: number) => number): number[] => {
  const termCounts = Array.from({ length: termCount }, (_, termIndex) => countOf(termIndex));
  const reference = Math.max(...termCounts);
  const foundWeights = termCounts.map((count) => (count > 0 ? Math.log(1 + reference / count) : undefined));
  const rarestFoundWeight = Math.max(0, ...foundWeights.filter((weight): weight is number => weight !== undefined));
  const absentWeight = rarestFoundWeight > 0 ? rarestFoundWeight : 1;
  return foundWeights.map((weight) => weight ?? absentWeight);
};
