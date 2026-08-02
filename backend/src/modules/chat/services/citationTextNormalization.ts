// Punctuation that terminates a clause, in any script Radioso answers in.
//
// `Terminal_Punctuation` is the Unicode property for marks that end a sentence or clause,
// so it covers `.,;:!?` alongside `。`, `、`, `，`, `！`, `？` (CJK), `؟`, `،`, `؛` (Arabic),
// `।`, `॥` (Devanagari), and `።` (Ethiopic) without enumerating scripts or keywords. Its
// ASCII footprint is exactly the `.,;:!?` this seam has always used, so widening to it
// adds multilingual reach without changing any Latin behavior.
//
// `…` and `·` are excluded because Unicode does not classify them as terminal, and a space
// before them is usually deliberate elision or separator typography rather than a clause
// ending — matching the behavior this seam has always had.
const CLAUSE_TERMINATOR = "\\p{Terminal_Punctuation}";

// Closing brackets (`Pe`) and final quotes (`Pf`) look detached the same way, but only at
// the narrow anchor seam below. They are deliberately absent from the spacing rule, which
// runs over arbitrary answer text where a space before `}`, `)`, or `»` is meaningful
// (`:hover { color: red; }`, `« citation »`).
const CLOSING_DELIMITER = "\\p{Pe}\\p{Pf}";

const DETACHED_PUNCTUATION_SPACING = new RegExp(`[ \\t]+(?=[${CLAUSE_TERMINATOR}])`, "gu");

export const removeDetachedPunctuationSpacing = (text: string): string =>
  text
    .replace(DETACHED_PUNCTUATION_SPACING, "")
    .replace(/[ \t]+(\r?\n)/g, "$1");

// Punctuation that, when a citation anchor was detached onto its own line right before it
// (`claim\n\n[[1]].`), would be stranded on a new line once the anchor is removed. Scoped
// to the anchor-removal seam only — never applied to arbitrary answer text, which
// legitimately starts lines with `:`, `.`, etc. (CSS, filenames).
export const STRANDABLE_PUNCTUATION = new RegExp(
  `^[ \\t]*[${CLAUSE_TERMINATOR}${CLOSING_DELIMITER}]`,
  "u",
);
