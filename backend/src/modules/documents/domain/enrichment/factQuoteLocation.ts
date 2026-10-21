import type { QuotedTemporalFact, TemporalFact } from "./documentEnrichmentContract.js";

/**
 * Text folded for matching, with each folded character's span in the original.
 * Folding is orthographic only — it never encodes vocabulary — so a quote
 * matches whatever the language, as long as the model copied it.
 */
interface FoldedText {
  text: string;
  starts: number[];
  ends: number[];
}

const COMBINING_MARK = /\p{M}/u;
const WHITESPACE = /\s/u;
const DASH = /[\p{Pd}−]/u;
const SINGLE_QUOTES = new Set(["‘", "’", "‚", "‛", "′"]);
const DOUBLE_QUOTES = new Set(["“", "”", "„", "‟", "″", "«", "»"]);
// Markdown emphasis and code markers: a model quoting rendered text drops them.
const IGNORED = new Set(["*", "_", "`"]);

const foldCharacter = (character: string): string => {
  if (DASH.test(character)) {
    return "-";
  }
  if (SINGLE_QUOTES.has(character)) {
    return "'";
  }
  if (DOUBLE_QUOTES.has(character)) {
    return "\"";
  }
  // Lowercase, then decompose and drop accents: "È", "è", and "è" all fold to "e".
  return [...character.toLowerCase().normalize("NFKD")].filter((part) => !COMBINING_MARK.test(part)).join("");
};

/** Case, accents, dash and quote styles, whitespace runs, and emphasis markers do not affect a match. */
const foldText = (value: string): FoldedText => {
  const folded: FoldedText = { text: "", starts: [], ends: [] };
  let pendingSpaceAt: number | null = null;
  for (let index = 0; index < value.length;) {
    const character = String.fromCodePoint(value.codePointAt(index) ?? 0);
    const end = index + character.length;
    if (WHITESPACE.test(character)) {
      pendingSpaceAt ??= folded.text.length > 0 ? index : null;
    } else if (!IGNORED.has(character)) {
      const replacement = foldCharacter(character);
      if (replacement.length === 0 && folded.ends.length > 0) {
        // A combining mark belongs to the character before it.
        folded.ends[folded.ends.length - 1] = end;
      }
      if (replacement.length > 0 && pendingSpaceAt !== null) {
        folded.text += " ";
        folded.starts.push(pendingSpaceAt);
        folded.ends.push(index);
        pendingSpaceAt = null;
      }
      for (const part of replacement) {
        folded.text += part;
        folded.starts.push(index);
        folded.ends.push(end);
      }
    }
    index = end;
  }
  return folded;
};

const occurrencesOf = (haystack: FoldedText, needle: string): Array<{ start: number; end: number }> => {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let at = haystack.text.indexOf(needle); at !== -1; at = haystack.text.indexOf(needle, at + 1)) {
    ranges.push({ start: haystack.starts[at] ?? 0, end: haystack.ends[at + needle.length - 1] ?? 0 });
  }
  return ranges;
};

const toTemporalFact = (fact: QuotedTemporalFact, sourceRange: TemporalFact["sourceRange"]): TemporalFact => ({
  kind: fact.kind,
  ...(fact.dateFrom ? { dateFrom: fact.dateFrom } : {}),
  ...(fact.dateTo ? { dateTo: fact.dateTo } : {}),
  ...(fact.unresolvedText ? { unresolvedText: fact.unresolvedText } : {}),
  sourceRange,
});

/**
 * Places each quoted fact in the document body, in the offsets chunks use.
 *
 * - A quote found in the body takes the span it matched. Facts arrive in
 *   document order, so a quote that repeats resolves to its first occurrence
 *   after the previous placed fact, or to its first occurrence when none follows.
 * - A quote found only in the title dates the document as a whole: it is kept
 *   with no range and sits on no particular chunk.
 * - A quote found in neither is dropped and counted. The representation's
 *   created-at line is not document text, so a quote from it is dropped too.
 */
export const locateQuotedFacts = (input: {
  facts: readonly QuotedTemporalFact[];
  body: string;
  title: string;
}): { facts: TemporalFact[]; unplacedCount: number } => {
  const body = foldText(input.body);
  const title = foldText(input.title);
  const facts: TemporalFact[] = [];
  let unplacedCount = 0;
  let cursor = 0;

  for (const fact of input.facts) {
    const quote = foldText(fact.quote).text;
    const occurrences = quote ? occurrencesOf(body, quote) : [];
    const placed = occurrences.find((range) => range.start >= cursor) ?? occurrences[0];
    if (placed) {
      facts.push(toTemporalFact(fact, placed));
      cursor = placed.end;
    } else if (quote && title.text.includes(quote)) {
      facts.push(toTemporalFact(fact, null));
    } else {
      unplacedCount += 1;
    }
  }

  return { facts, unplacedCount };
};
