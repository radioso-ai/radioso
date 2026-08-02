import { describe, expect, it } from "vitest";

import {
  removeDetachedPunctuationSpacing,
  STRANDABLE_PUNCTUATION,
} from "../../src/modules/chat/services/citationTextNormalization.js";

interface SpacingCase {
  script: string;
  input: string;
  expected: string;
}

// Radioso answers in any language the sources are written in, so the "punctuation an
// anchor detached itself from" class must be Unicode-defined, not the Latin subset.
const detachedSpacingCases: SpacingCase[] = [
  { script: "English full stop", input: "a claim .", expected: "a claim." },
  { script: "English comma", input: "first , second", expected: "first, second" },
  { script: "English semicolon", input: "first ; second", expected: "first; second" },
  { script: "English colon", input: "label : value", expected: "label: value" },
  { script: "English exclamation", input: "great !", expected: "great!" },
  { script: "English question", input: "really ?", expected: "really?" },
  { script: "Chinese ideographic full stop", input: "这是一个说法 。", expected: "这是一个说法。" },
  { script: "Chinese ideographic comma", input: "第一 、第二", expected: "第一、第二" },
  { script: "Fullwidth comma", input: "第一 ，第二", expected: "第一，第二" },
  { script: "Japanese fullwidth question", input: "本当ですか ？", expected: "本当ですか？" },
  { script: "Japanese fullwidth exclamation", input: "すごい ！", expected: "すごい！" },
  { script: "Arabic question mark", input: "ما هذا ؟", expected: "ما هذا؟" },
  { script: "Arabic comma", input: "الأول ، الثاني", expected: "الأول، الثاني" },
  { script: "Arabic semicolon", input: "الأول ؛ الثاني", expected: "الأول؛ الثاني" },
  { script: "Hindi danda", input: "यह एक दावा है ।", expected: "यह एक दावा है।" },
  { script: "Hindi double danda", input: "यह एक दावा है ॥", expected: "यह एक दावा है॥" },
  { script: "Ethiopic full stop", input: "ይህ አንድ ነገር ነው ።", expected: "ይህ አንድ ነገር ነው።" },
  { script: "tab before punctuation", input: "a claim\t.", expected: "a claim." },
  { script: "multiple spaces before punctuation", input: "a claim   .", expected: "a claim." },
];

// Spacing before these must survive: they are openers (the space belongs to the
// preceding word), structural closing delimiters whose leading space is meaningful in
// code and typography, or ordinary content. This rule runs over arbitrary answer text,
// so it is scoped to clause terminators only.
const preservedSpacingCases: SpacingCase[] = [
  { script: "opening parenthesis", input: "a note (aside)", expected: "a note (aside)" },
  { script: "closing brace in a code snippet", input: ":hover { color: red; }", expected: ":hover { color: red; }" },
  { script: "closing parenthesis", input: "call(a, b )", expected: "call(a, b )" },
  { script: "closing square bracket", input: "arr[0 ]", expected: "arr[0 ]" },
  { script: "final guillemet", input: "une citation »", expected: "une citation »" },
  { script: "final double quote", input: "a quote ”", expected: "a quote ”" },
  { script: "fullwidth opening parenthesis", input: "注 （説明）", expected: "注 （説明）" },
  { script: "initial guillemet", input: "il a dit «bonjour»", expected: "il a dit «bonjour»" },
  { script: "initial double quote", input: "he said “hello”", expected: "he said “hello”" },
  { script: "opening square bracket", input: "see [1](https://x.test)", expected: "see [1](https://x.test)" },
  { script: "ordinary Latin word", input: "a claim word", expected: "a claim word" },
  { script: "ordinary CJK word", input: "这是 说法", expected: "这是 说法" },
  { script: "digit", input: "EUR 18", expected: "EUR 18" },
  { script: "hyphen", input: "well - known", expected: "well - known" },
  // Not Terminal_Punctuation, and a space before an ellipsis is usually deliberate
  // elision typography rather than a claim-closing mark.
  { script: "ellipsis", input: "wait …", expected: "wait …" },
  { script: "Greek ano teleia", input: "πρώτο · δεύτερο", expected: "πρώτο · δεύτερο" },
  { script: "emphasis marker", input: "a claim *word*", expected: "a claim *word*" },
];

describe("removeDetachedPunctuationSpacing", () => {
  for (const { script, input, expected } of detachedSpacingCases) {
    it(`closes the gap before ${script}`, () => {
      expect(removeDetachedPunctuationSpacing(input)).toBe(expected);
    });
  }

  for (const { script, input, expected } of preservedSpacingCases) {
    it(`preserves spacing before ${script}`, () => {
      expect(removeDetachedPunctuationSpacing(input)).toBe(expected);
    });
  }

  it("still trims trailing horizontal whitespace before a line break", () => {
    expect(removeDetachedPunctuationSpacing("a claim  \nnext line")).toBe("a claim\nnext line");
    expect(removeDetachedPunctuationSpacing("a claim  \r\nnext line")).toBe("a claim\r\nnext line");
  });
});

interface StrandableCase {
  script: string;
  input: string;
}

// The line-leading anchor seam is narrower than the spacing rule: it only ever inspects
// the text that directly follows a removed anchor, so closing delimiters and final quotes
// belong here even though a leading space before them elsewhere is meaningful.
const strandableCases: StrandableCase[] = [
  { script: "English full stop", input: ". next" },
  { script: "English comma", input: ", next" },
  { script: "English semicolon", input: "; next" },
  { script: "English colon", input: ": next" },
  { script: "English exclamation", input: "! next" },
  { script: "English question", input: "? next" },
  { script: "Chinese ideographic full stop", input: "。 下一个" },
  { script: "Chinese ideographic comma", input: "、下一个" },
  { script: "Fullwidth comma", input: "，下一个" },
  { script: "Japanese fullwidth question", input: "？ 次" },
  { script: "Arabic question mark", input: "؟ التالي" },
  { script: "Arabic comma", input: "، التالي" },
  { script: "Arabic semicolon", input: "؛ التالي" },
  { script: "Hindi danda", input: "। अगला" },
  { script: "Hindi double danda", input: "॥ अगला" },
  { script: "Ethiopic full stop", input: "። ቀጣይ" },
  { script: "closing parenthesis", input: ") next" },
  { script: "CJK closing corner bracket", input: "」 次" },
  { script: "final double quote", input: "” next" },
  { script: "leading space then punctuation", input: "  . next" },
  { script: "leading tab then punctuation", input: "\t. next" },
];

const notStrandableCases: StrandableCase[] = [
  { script: "opening parenthesis", input: "(aside) next" },
  { script: "fullwidth opening parenthesis", input: "（説明）次" },
  { script: "initial guillemet", input: "«bonjour» ensuite" },
  { script: "initial double quote", input: "“hello” next" },
  { script: "opening square bracket", input: "[label](https://x.test)" },
  { script: "ordinary Latin word", input: "next line of prose" },
  { script: "ordinary CJK word", input: "下一个说法" },
  { script: "ordinary Arabic word", input: "التالي" },
  { script: "ordinary Devanagari word", input: "अगला" },
  { script: "digit", input: "2024 label" },
  { script: "ellipsis", input: "… next" },
  { script: "Greek ano teleia", input: "· δεύτερο" },
  { script: "newline before punctuation", input: "\n. next" },
  { script: "empty string", input: "" },
];

describe("STRANDABLE_PUNCTUATION", () => {
  for (const { script, input } of strandableCases) {
    it(`treats a leading ${script} as strandable`, () => {
      expect(STRANDABLE_PUNCTUATION.test(input)).toBe(true);
    });
  }

  for (const { script, input } of notStrandableCases) {
    it(`does not treat a leading ${script} as strandable`, () => {
      expect(STRANDABLE_PUNCTUATION.test(input)).toBe(false);
    });
  }

  it("is stateless across repeated tests", () => {
    // A `g`-flagged regex would alternate results through `lastIndex`; this one must not.
    expect(STRANDABLE_PUNCTUATION.test(". next")).toBe(true);
    expect(STRANDABLE_PUNCTUATION.test(". next")).toBe(true);
    expect(STRANDABLE_PUNCTUATION.test("。 next")).toBe(true);
    expect(STRANDABLE_PUNCTUATION.test("。 next")).toBe(true);
  });
});
