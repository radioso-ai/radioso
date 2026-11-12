import type { OpenUprightImage } from "./guardedDecode.js";

/** One encoded width of an image. `width` is what was produced, which is less than asked when the source is narrower. */
interface WebpRendition {
  readonly width: number;
  readonly height: number;
  readonly webp: Buffer;
}

const DEFAULT_QUALITY = 80;
/** The longest side WebP can hold. A tall image shrinks further to fit it instead of failing. */
const WEBP_MAX_SIDE_PX = 16_383;

/**
 * Re-encodes an image into one WebP per requested width, in the order asked: the aspect ratio
 * kept, never enlarged, at most 16,383 px tall, transparency kept, and no metadata (EXIF, GPS,
 * ICC, XMP) carried over.
 */
export const encodeWebpRenditions = async (
  open: OpenUprightImage,
  options: { readonly widthsPx: readonly number[]; readonly quality?: number },
): Promise<WebpRendition[]> => {
  const renditions: WebpRendition[] = [];
  for (const width of options.widthsPx) {
    const { data, info } = await open()
      .resize({ width, height: WEBP_MAX_SIDE_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: options.quality ?? DEFAULT_QUALITY })
      .toBuffer({ resolveWithObject: true });
    renditions.push({ width: info.width, height: info.height, webp: data });
  }
  return renditions;
};
