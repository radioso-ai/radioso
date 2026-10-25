import type { LexicalQueryPlan } from "./retrievalPipelineTypes.js";

/**
 * What a lexical search may return. `all_terms` keeps to chunks holding every term,
 * which a caller promising exact-term matching needs; `all_or_some_terms` adds the
 * some-terms pass when too few chunks hold every term.
 */
export type LexicalMatchMode = "all_terms" | "all_or_some_terms";

/**
 * What the some-terms pass did on one search: `skipped` (with its reason), `ran`,
 * `timed_out` (its time budget ran out), or `failed` (another database error). After a
 * timeout or a failure the search keeps its all-terms hits.
 */
export type LexicalSomeTermsPassOutcome = "skipped" | "ran" | "timed_out" | "failed";

export type LexicalSomeTermsPassSkipReason =
  /** The caller asked for chunks holding every term. */
  | "all_terms_only"
  | "enough_all_terms_matches"
  /** One term, explicit OR alternatives, or nothing searchable. */
  | "nothing_to_relax"
  /** Other requests were waiting for a database connection. */
  | "connections_busy"
  /** The all-terms search itself failed. */
  | "lexical_unavailable";

export type LexicalSomeTermsPassReport =
  | { outcome: "skipped"; reason: LexicalSomeTermsPassSkipReason; durationMs: 0 }
  | { outcome: Exclude<LexicalSomeTermsPassOutcome, "skipped">; durationMs: number };

export const skippedSomeTermsPass = (reason: LexicalSomeTermsPassSkipReason): LexicalSomeTermsPassReport => ({
  outcome: "skipped",
  reason,
  durationMs: 0,
});

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
  /** The query held more terms than one search counts; the later ones were left out. */
  truncated: boolean;
}

/**
 * The most terms one search counts. Every term costs a capped count, so this bounds a
 * pasted paragraph; the ranking then keeps only the rarest of them.
 */
const MAX_SOME_TERMS_QUERY_TERMS = 32;

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
  let truncated = false;
  const termIndexByKey = new Map<string, number>();
  for (const phrase of option.phrases) {
    const words = termsOf(phrase);
    if (words.length === 0) {
      continue;
    }
    if (termCount >= MAX_SOME_TERMS_QUERY_TERMS) {
      truncated = true;
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
        truncated = true;
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
    truncated,
  };
};

/**
 * How the adapter ranks some-terms matches. A term weighs more the fewer of the
 * workspace's chunks hold it, so the ranking needs no list of words to ignore in any
 * language: a word on most pages weighs least wherever it comes from.
 */
export interface SomeTermsRankingPlan {
  /** Weight of each query term, by term index; 0 for a term the ranking leaves out. */
  termWeights: number[];
  /** Alternatives covering at least one ranked term: the hits a chunk is scored on. */
  scoredAlternatives: number[];
  /** Alternatives whose matches make up the ranked chunk set, rarest first. */
  matchingAlternatives: number[];
  totalWeight: number;
  /** A ranked chunk must hold at least this much term weight. */
  minimumCoveredWeight: number;
  /**
   * Whether a ranked chunk can hold every query term. It cannot when the query was cut
   * at the term limit, or when a term was left out of the ranking: matched nothing,
   * matched past the count cap, or fell outside the rarest terms.
   */
  everyTermRanked: boolean;
}

// The floors are sums of logarithms; this keeps a chunk that sits exactly on one from
// falling off through rounding.
const COVERED_WEIGHT_TOLERANCE = 1e-9;

export const planSomeTermsRanking = (input: {
  query: SomeTermsLexicalQuery;
  /** Chunks in scope that match each alternative, counted up to `matchCap + 1`. */
  alternativeMatchCounts: readonly number[];
  /** Chunks in scope, the same scope the alternatives were counted in. */
  scopeChunkCount: number;
  /** An alternative matching more chunks than this cannot find a chunk on its own. */
  matchCap: number;
  /** The most chunks the ranking reads, summed over the alternatives that define them. */
  rankedChunkBudget: number;
  /** The share of the query's found term weight a ranked chunk must hold. */
  minimumWeightShare: number;
  /** The term weight a ranked chunk must hold, however few terms the query found. */
  minimumHeldWeight: number;
  /** The most terms a chunk is scored on; the rarest are kept. */
  maxRankedTerms: number;
}): SomeTermsRankingPlan | null => {
  const { query } = input;
  const countOf = (alternativeIndex: number): number =>
    Math.min(Math.max(input.alternativeMatchCounts[alternativeIndex] ?? 0, 0), input.matchCap + 1);

  const termMatchCounts = countTermMatches(query, countOf);
  const scopeChunkCount = Math.max(input.scopeChunkCount, ...termMatchCounts.filter((count) => count <= input.matchCap));
  const termWeights = weighTerms(termMatchCounts, scopeChunkCount, input.matchCap);
  const rankedTerms = new Set(selectRarestTerms(termMatchCounts, termWeights, input.maxRankedTerms));
  const rankedWeights = termWeights.map((weight, term) => (rankedTerms.has(term) ? weight : 0));
  const totalWeight = rankedWeights.reduce((sum, weight) => sum + weight, 0);
  const minimumCoveredWeight = Math.max(totalWeight * input.minimumWeightShare, input.minimumHeldWeight)
    * (1 - COVERED_WEIGHT_TOLERANCE);
  // Even a chunk holding every ranked term would fall short of the absolute floor.
  if (totalWeight < minimumCoveredWeight) {
    return null;
  }

  const scoredAlternatives = query.alternatives
    .map((alternative, index) => ({ alternative, index }))
    .filter(({ alternative }) => alternative.covers.some((term) => rankedTerms.has(term)))
    .map(({ index }) => index);
  const matchingAlternatives = selectMatchingAlternatives(scoredAlternatives, countOf, input);
  if (matchingAlternatives.length === 0) {
    return null;
  }

  return {
    termWeights: rankedWeights,
    scoredAlternatives,
    matchingAlternatives,
    totalWeight,
    minimumCoveredWeight,
    everyTermRanked: !query.truncated && rankedTerms.size === query.termCount,
  };
};

// A term's chunks are those holding any alternative that covers it, so "super" in
// "super coscienti" also counts the chunks writing "supercoscienti". The sum over
// alternatives is an upper bound on that union, which is all the weighting needs.
const countTermMatches = (query: SomeTermsLexicalQuery, countOf: (alternativeIndex: number) => number): number[] => {
  const counts = Array.from({ length: query.termCount }, () => 0);
  query.alternatives.forEach((alternative, index) => {
    for (const term of alternative.covers) {
      counts[term] = (counts[term] ?? 0) + countOf(index);
    }
  });
  return counts;
};

// Inverse document frequency, ln(chunks in scope / chunks holding the term). It is
// absolute, so a query whose only found term sits on most pages finds nothing rather
// than scoring every one of those pages as a full match. A term found nowhere tells
// nothing about any chunk, and a term past the count cap has an unknown frequency that
// a guess would overstate, so both weigh 0.
const weighTerms = (termMatchCounts: number[], scopeChunkCount: number, matchCap: number): number[] =>
  termMatchCounts.map((count) =>
    count > 0 && count <= matchCap && scopeChunkCount > count ? Math.log(scopeChunkCount / count) : 0);

const selectRarestTerms = (termMatchCounts: number[], termWeights: number[], maxRankedTerms: number): number[] =>
  termMatchCounts
    .map((count, term) => ({ count, term }))
    .filter(({ term }) => (termWeights[term] ?? 0) > 0)
    .sort((left, right) => left.count - right.count || left.term - right.term)
    .slice(0, Math.max(0, maxRankedTerms))
    .map(({ term }) => term);

const selectMatchingAlternatives = (
  scoredAlternatives: number[],
  countOf: (alternativeIndex: number) => number,
  limits: { matchCap: number; rankedChunkBudget: number },
): number[] => {
  const candidates = scoredAlternatives
    .map((index) => ({ index, count: countOf(index) }))
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
