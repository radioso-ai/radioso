import { UNSUPPORTED_NOTICE_MARKER } from "./unsupportedNoticeMarker.js";
import { removeDetachedPunctuationSpacing } from "./citationTextNormalization.js";

const COMPLETE_ANCHOR = /\[\[\d+\]\]/g;
const ANY_BRACKET_ANCHOR = /\[\[[^\]]*?\]\]/g;

const stripCompleteAnchors = (text: string): string =>
  removeDetachedPunctuationSpacing(text
    .replace(COMPLETE_ANCHOR, "")
    .replace(ANY_BRACKET_ANCHOR, ""));

const stripUnsupportedNoticeMarkers = (text: string): string =>
  text.split(UNSUPPORTED_NOTICE_MARKER).join("");

const resolveUnsupportedMarkerCarryStart = (text: string): number | null => {
  for (let length = Math.min(text.length, UNSUPPORTED_NOTICE_MARKER.length - 1); length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (UNSUPPORTED_NOTICE_MARKER.startsWith(suffix)) {
      return text.length - length;
    }
  }

  return null;
};

export class CitationAnchorSanitizer {
  private carry = "";

  push(chunk: string): string {
    const combined = `${this.carry}${chunk ?? ""}`;
    this.carry = "";

    const stripped = stripUnsupportedNoticeMarkers(stripCompleteAnchors(combined));

    const markerCarryStart = resolveUnsupportedMarkerCarryStart(stripped);
    if (markerCarryStart !== null) {
      this.carry = stripped.slice(markerCarryStart).slice(-UNSUPPORTED_NOTICE_MARKER.length);
      return stripped.slice(0, markerCarryStart);
    }

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
