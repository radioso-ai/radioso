const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const NUL = 0x00;
/** How many line feeds a run of blank lines keeps. */
const MAX_LINE_FEEDS = 2;

/** The code units `String.prototype.trim` removes. */
const WHITESPACE = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

const STRING_CHUNK = 8_192;

const decode = (codes) => {
  let text = "";
  for (let start = 0; start < codes.length; start += STRING_CHUNK) {
    text += String.fromCharCode(...codes.subarray(start, start + STRING_CHUNK));
  }
  return text;
};

/** The first index in `sorted[from, to)` whose value is at least `value`. */
const lowerBound = (sorted, from, to, value) => {
  let low = from;
  let high = to;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * The text every parser's output is stored as: line endings as line feeds, no NUL characters, no
 * more than one blank line in a row, and no surrounding whitespace. Each offset into `value` is
 * moved to where the same place falls in the result. Every step only drops or replaces code units,
 * so an offset lands before the first kept unit that came at or after it.
 */
export const normalizeTextWithOffsets = (value, offsets = []) => {
  const codes = new Uint16Array(value.length);
  const origins = new Uint32Array(value.length);
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === NUL) continue;
    if (code === CARRIAGE_RETURN) {
      if (value.charCodeAt(index + 1) === LINE_FEED) continue;
      codes[length] = LINE_FEED;
    } else {
      codes[length] = code;
    }
    origins[length] = index;
    length += 1;
  }

  // A NUL between line breaks is gone before blank lines collapse, so runs are counted after it.
  let kept = 0;
  let lineFeeds = 0;
  for (let index = 0; index < length; index += 1) {
    lineFeeds = codes[index] === LINE_FEED ? lineFeeds + 1 : 0;
    if (lineFeeds > MAX_LINE_FEEDS) continue;
    codes[kept] = codes[index];
    origins[kept] = origins[index];
    kept += 1;
  }

  let start = 0;
  while (start < kept && WHITESPACE.has(codes[start])) start += 1;
  let end = kept;
  while (end > start && WHITESPACE.has(codes[end - 1])) end -= 1;

  return {
    text: decode(codes.subarray(start, end)),
    offsets: offsets.map((offset) => lowerBound(origins, start, end, offset) - start),
  };
};

export const normalizeText = (value) => normalizeTextWithOffsets(value).text;
