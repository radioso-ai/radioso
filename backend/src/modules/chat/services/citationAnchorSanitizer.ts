import { removeDetachedPunctuationSpacing } from "./citationTextNormalization.js";

const COMPLETE_ANCHOR = /\[\[\d+\]\]/g;
const ANY_BRACKET_ANCHOR = /\[\[[^\]]*?\]\]/g;

const stripCompleteAnchors = (text: string): string =>
  removeDetachedPunctuationSpacing(text
    .replace(COMPLETE_ANCHOR, "")
    .replace(ANY_BRACKET_ANCHOR, ""));

export class CitationAnchorSanitizer {
  private carry = "";

  push(chunk: string): string {
    const combined = `${this.carry}${chunk ?? ""}`;
    this.carry = "";

    const stripped = stripCompleteAnchors(combined);

    const suffixMatch = stripped.match(/\[\[[^\]]*$/);
    if (suffixMatch && suffixMatch.index !== undefined) {
      const start = suffixMatch.index;
      this.carry = stripped.slice(start).slice(-32);
      return stripped.slice(0, start);
    }

    if (stripped.endsWith("[")) {
      this.carry = "[";
      return stripped.slice(0, -1);
    }

    const trailingWhitespace = stripped.match(/[ \t]+$/)?.[0];
    if (trailingWhitespace) {
      this.carry = trailingWhitespace;
      return stripped.slice(0, -trailingWhitespace.length);
    }

    return stripped;
  }

  flush(): string {
    this.carry = "";
    return "";
  }
}
