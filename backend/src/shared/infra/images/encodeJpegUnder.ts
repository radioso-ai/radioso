import type { OpenUprightImage } from "./guardedDecode.js";

/** How big the JPEG may be: its long side, the smaller long sides tried when that does not fit, and its bytes. */
interface JpegBudget {
  readonly maxLongSidePx: number;
  /** Tried in turn, at the lowest quality, once no quality fits at `maxLongSidePx`. */
  readonly fallbackLongSidesPx: readonly number[];
  readonly maxBytes: number;
}

type EncodedJpeg =
  | { readonly kind: "encoded"; readonly jpeg: Buffer; readonly width: number; readonly height: number }
  | { readonly kind: "too_large" };

/** Qualities tried in turn until the file fits; then the long side shrinks at the last of them. */
const JPEG_QUALITIES = [85, 75, 65, 55, 45] as const;

/**
 * Re-encodes an image into one JPEG within the budget: never enlarged, transparency flattened onto
 * white, and no metadata (EXIF, GPS, ICC) carried over. `too_large` when even the smallest attempt
 * does not fit.
 */
export const encodeJpegUnder = async (open: OpenUprightImage, budget: JpegBudget): Promise<EncodedJpeg> => {
  const lowestQuality = JPEG_QUALITIES[JPEG_QUALITIES.length - 1];
  const attempts = [
    ...JPEG_QUALITIES.map((quality) => ({ longSide: budget.maxLongSidePx, quality })),
    ...budget.fallbackLongSidesPx.map((longSide) => ({ longSide, quality: lowestQuality })),
  ];
  for (const attempt of attempts) {
    const { data, info } = await open()
      .resize({ width: attempt.longSide, height: attempt.longSide, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: attempt.quality, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    if (data.length <= budget.maxBytes) return { kind: "encoded", jpeg: data, width: info.width, height: info.height };
  }
  return { kind: "too_large" };
};
