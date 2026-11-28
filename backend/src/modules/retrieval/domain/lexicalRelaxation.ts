import { lexicalOptionTerms, lexicalTermsOf } from "./lexicalQueryPlan.js";
import type { LexicalSearchOption } from "./retrievalPipelineTypes.js";
import { isSomeTermsLexicalMatch, type RetrievedChunk } from "./vectorSearch.js";

// Where a heading's name ends and its tagline, price, or note begins: a dash, a colon, a bar, or an
// opening bracket, in ASCII or full width. A hyphen ends it only with space on both sides, so a
// hyphenated name stays whole.
const HEADING_NAME_END = /\s-\s|[—–:：|｜(（[［]/u;
const NUMBER_ONLY = /^\p{N}+$/u;

/** The words a heading names its section by: those before its first separator, numbers left out. */
const headingNameTerms = (heading: string): string[] =>
  lexicalTermsOf(heading.split(HEADING_NAME_END, 1)[0] ?? "").filter((term) => !NUMBER_ONLY.test(term));

/**
 * Whether one of a chunk's headings names the relaxed item: the heading's name holds every term of
 * the alternative and no word outside the phrase it relaxes. `### Planet`, `### Planet — €579/mo`
 * and `### 3. Planet` name the item of `Planet plan OR Planet`; `### Gold sponsor` does not name
 * the item of `Gold plan OR Gold`.
 *
 * Each heading is judged alone, never by the headings above it. A chunk holds only the headings
 * inside its own window, so a parent heading is there for one chunk of a section and missing for
 * the next. And whether a parent names a different kind of thing (`Sponsorship tiers` above
 * `### Gold`, beside `Plans and pricing` above `### Planet`) is a question of meaning that word
 * comparison cannot settle in every language without a vocabulary. A chunk without a heading
 * (most PDF text, or a chunk that starts partway through a section) names nothing, so its hits
 * are part matches.
 */
const headingNamesItem = (headings: readonly string[], ownTerms: readonly string[], phraseTerms: ReadonlySet<string>): boolean =>
  headings.some((heading) => {
    const nameTerms = headingNameTerms(heading);
    return ownTerms.every((term) => nameTerms.includes(term)) && nameTerms.every((term) => phraseTerms.has(term));
  });

/**
 * Weighs the hits of a relaxation, an alternative that searches part of a sibling's terms (`Planet`
 * beside `Planet plan`). An all-terms hit under a heading that names the item is the item's own
 * section and stays full evidence; every other hit names the item in passing, or names something
 * else, and holds only part of what the sibling asks for, so it counts as a part match. Full evidence
 * comes first, scored relative to the strongest of its kind; a part match scores the share of the
 * sibling's terms it holds.
 */
export const weighRelaxedLexicalHits = (input: {
  option: LexicalSearchOption;
  hits: RetrievedChunk[];
  headingsOf: (hit: RetrievedChunk) => readonly string[];
}): RetrievedChunk[] => {
  const phrase = input.option.relaxationOf;
  if (!phrase || phrase.length === 0) {
    return input.hits;
  }
  const phraseTerms = new Set(phrase);
  const ownTerms = lexicalOptionTerms(input.option);
  const named = input.hits.filter((hit) =>
    !isSomeTermsLexicalMatch(hit) && headingNamesItem(input.headingsOf(hit), ownTerms, phraseTerms));
  const namedIds = new Set(named.map((hit) => hit.chunkId));
  const strongestNamed = Math.max(0, ...named.map((hit) => hit.lexicalRankScore ?? 0));
  const partShare = ownTerms.length / phraseTerms.size;
  return [
    ...named.map((hit) => ({
      ...hit,
      similarity: strongestNamed > 0 ? (hit.lexicalRankScore ?? 0) / strongestNamed : hit.similarity,
    })),
    // A hit already holding only part of the alternative holds less of the sibling still.
    ...input.hits
      .filter((hit) => !namedIds.has(hit.chunkId))
      .map((hit) => ({
        ...hit,
        similarity: isSomeTermsLexicalMatch(hit) ? hit.similarity * partShare : partShare,
        lexicalTermCoverage: "some_terms" as const,
      })),
  ];
};
