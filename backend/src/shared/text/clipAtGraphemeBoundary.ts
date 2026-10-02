const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest prefix of `value` that fits in `maxLength` UTF-16 code units and ends on a
 * grapheme boundary, so a clipped label never ends in half an emoji or a bare base letter.
 * When the first character alone is longer than the limit (a letter under hundreds of
 * combining marks), it is cut between code points instead, so the text never vanishes.
 */
export const clipAtGraphemeBoundary = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  let end = 0;
  for (const { index, segment } of graphemes.segment(value)) {
    if (index + segment.length > maxLength) break;
    end = index + segment.length;
  }
  if (end > 0) return value.slice(0, end);
  const cut = value.slice(0, maxLength);
  // Never end on half of a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
};
