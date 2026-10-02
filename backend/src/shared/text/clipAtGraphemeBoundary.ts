const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The longest prefix of `value` that fits in `maxLength` UTF-16 code units and ends on a
 * grapheme boundary, so a clipped label never ends in half an emoji or a bare base letter.
 */
export const clipAtGraphemeBoundary = (value: string, maxLength: number): string => {
  if (value.length <= maxLength) return value;
  let end = 0;
  for (const { index, segment } of graphemes.segment(value)) {
    if (index + segment.length > maxLength) break;
    end = index + segment.length;
  }
  return value.slice(0, end);
};
