/**
 * How a Markdown renderer reads the address inside a link, and where a bare address ends.
 *
 * It knows the escaping and spelling rules of CommonMark and GFM destinations and nothing
 * about which address is acceptable: a caller decides that from the address as a reader's
 * browser or phone would receive it.
 */

const TITLE = /^(?:"[^"]*"|'[^']*'|\([^()]*\))$/;
const WHITESPACE_RUN = /\s+/;

// A backslash escape of ASCII punctuation, or a numeric or named character reference.
const DESTINATION_ESCAPE = /\\([!-/:-@[-`{-~])|&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;

// The references that spell the structure of an address: its separators and the `+` of a
// phone number. A reference outside this set is left as written.
const STRUCTURAL_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
  plus: "+",
  colon: ":",
  sol: "/",
  period: ".",
  comma: ",",
  lpar: "(",
  rpar: ")",
  num: "#",
  quest: "?",
  equals: "=",
  percnt: "%",
  commat: "@",
  semi: ";",
};

const codePointText = (value: number): string =>
  value > 0 && value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : "�";

/** The address a renderer follows: backslash escapes removed and character references decoded. */
const decodeDestination = (raw: string): string =>
  raw.replace(DESTINATION_ESCAPE, (whole, escaped?: string, decimal?: string, hex?: string, named?: string) => {
    if (escaped !== undefined) {
      return escaped;
    }
    if (decimal !== undefined) {
      return codePointText(Number(decimal));
    }
    if (hex !== undefined) {
      return codePointText(Number.parseInt(hex, 16));
    }
    return (named !== undefined ? STRUCTURAL_REFERENCES[named] : undefined) ?? whole;
  });

/** The destination of a `[text](…)` span: no title, no angle brackets, decoded. */
export const readDestination = (raw: string): string => {
  const inner = raw.trim();
  if (inner.startsWith("<")) {
    const close = inner.indexOf(">");
    if (close > 0 && (close === inner.length - 1 || TITLE.test(inner.slice(close + 1).trim()))) {
      return decodeDestination(inner.slice(1, close));
    }
  }
  const [first, ...rest] = inner.split(WHITESPACE_RUN);
  return decodeDestination(rest.length > 0 && TITLE.test(inner.slice(first.length).trim()) ? first : inner);
};

/**
 * The destination of a link reference definition's remainder, `url "title"`: null when what
 * follows the address is not a title, so the line is a paragraph and not a definition.
 */
export const readDefinitionDestination = (raw: string): string | null => {
  const inner = raw.trim();
  if (!inner) {
    return null;
  }
  if (inner.startsWith("<")) {
    const close = inner.indexOf(">");
    const rest = close > 0 ? inner.slice(close + 1).trim() : null;
    return close > 0 && (rest === "" || (rest !== null && TITLE.test(rest)))
      ? decodeDestination(inner.slice(1, close))
      : null;
  }
  const [first, ...rest] = inner.split(WHITESPACE_RUN);
  return rest.length === 0 || TITLE.test(inner.slice(first.length).trim()) ? decodeDestination(first) : null;
};

const TRAILING_PUNCTUATION = /[?!.,:*_~'"]$/;
const TRAILING_REFERENCE = /&[a-zA-Z0-9]+;$/;

const countOf = (text: string, char: string): number => text.split(char).length - 1;

// A closing, quoting, or sentence-ending mark outside ASCII: a typographic quote, a CJK full
// stop or comma. ASCII marks are handled one by one, because many are valid in an address.
const TRAILING_UNICODE_MARK = /(?=[^\x00-\x7f])[\p{Pe}\p{Pf}\p{Pi}\p{Po}]$/u;
const NON_ASCII = /[^\x00-\x7f]/u;

// Characters that, after the first non-ASCII one, make the rest a path, a file name, or a
// query: still part of the address, not prose glued to it.
const ADDRESS_STRUCTURE = /[/.?#=]/;

/**
 * Where a run of text that a renderer reads as one address may really end earlier: at its first
 * character outside ASCII, because an address written in ASCII is followed there by prose in
 * another script. `null` when the run is ASCII throughout, when the ASCII part ends in `/` (a
 * path continues there, in any script), or when the rest holds an address's own structure.
 */
export const asciiAddressEnd = (text: string, start: number, end: number): number | null => {
  const offset = text.slice(start, end).search(NON_ASCII);
  if (offset <= 0) {
    return null;
  }
  const prefixEnd = bareAddressEnd(text, start, start + offset);
  if (prefixEnd <= start || text[prefixEnd - 1] === "/" || ADDRESS_STRUCTURE.test(text.slice(start + offset, end))) {
    return null;
  }
  return prefixEnd;
};

/**
 * Where a bare address that runs from `start` to `end` stops being the address: trailing
 * punctuation (ASCII, or a typographic or CJK mark), an unbalanced closing parenthesis or
 * bracket, a table cell's closing bar, and a trailing character reference are not part of it.
 */
export const bareAddressEnd = (text: string, start: number, end: number): number => {
  let stop = end;
  while (stop > start) {
    const candidate = text.slice(start, stop);
    const last = candidate[candidate.length - 1];
    const unicodeMark = TRAILING_UNICODE_MARK.exec(candidate);
    if (unicodeMark) {
      stop -= unicodeMark[0].length;
    } else if (TRAILING_PUNCTUATION.test(last) || last === "|") {
      stop -= 1;
    } else if (last === ")" && countOf(candidate, ")") > countOf(candidate, "(")) {
      stop -= 1;
    } else if (last === "]" && countOf(candidate, "]") > countOf(candidate, "[")) {
      stop -= 1;
    } else if (last === ";" && TRAILING_REFERENCE.test(candidate)) {
      stop -= candidate.length - candidate.lastIndexOf("&");
    } else {
      break;
    }
  }
  return stop;
};
