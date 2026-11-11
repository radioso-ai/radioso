import { createHash } from "node:crypto";

import sharp from "sharp";

import { VISITOR_IMAGE_LIMITS, type VisitorImageRejection, type VisitorImageSourceType } from "../domain.js";

/**
 * The type a photo's first bytes say it is. Only JPEG, PNG and WebP are read; anything else,
 * including SVG and every format a decoder would otherwise try, is refused before decoding.
 */
export const sniffVisitorImageType = (bytes: Buffer): VisitorImageSourceType | null => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The decoder's own name for each type it may read, so a file whose content disagrees with its magic bytes is refused. */
const DECODED_FORMAT: Readonly<Record<VisitorImageSourceType, string>> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Qualities tried in turn until the stored file fits; then the long side shrinks at the last of them. */
const JPEG_QUALITIES = [85, 75, 65, 55, 45] as const;
const FALLBACK_LONG_SIDES = [1_200, 800] as const;

type NormalizedVisitorImage =
  | { readonly kind: "normalized"; readonly jpeg: Buffer; readonly width: number; readonly height: number; readonly sha256: string }
  | { readonly kind: "rejected"; readonly reason: VisitorImageRejection };

const encode = (bytes: Buffer, maxInputPixels: number, longSide: number, quality: number) =>
  sharp(bytes, { limitInputPixels: maxInputPixels, failOn: "error" })
    .rotate()
    .resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

/**
 * Re-encodes an uploaded photo into what Radioso stores: a JPEG at most 1,600 pixels on its long
 * side, turned upright from its orientation tag, with no metadata (EXIF, GPS, ICC) carried over, and
 * at most 512 KB. The type comes from the magic bytes alone, and decoding stops past the pixel
 * limit. Every channel's photos go through here, including those no browser shrank first.
 */
export const normalizeVisitorImage = async (
  bytes: Buffer,
  options: { maxInputPixels?: number } = {},
): Promise<NormalizedVisitorImage> => {
  if (bytes.length > VISITOR_IMAGE_LIMITS.maxUploadBytes) return { kind: "rejected", reason: "too_large" };
  const type = sniffVisitorImageType(bytes);
  if (!type) return { kind: "rejected", reason: "unsupported_type" };
  const maxInputPixels = options.maxInputPixels ?? VISITOR_IMAGE_LIMITS.maxInputPixels;
  try {
    // The header alone: the size is checked here, against the same limit decoding then enforces.
    const metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    if (metadata.format !== DECODED_FORMAT[type]) return { kind: "rejected", reason: "unsupported_type" };
    if ((metadata.width ?? 0) * (metadata.height ?? 0) > maxInputPixels) return { kind: "rejected", reason: "too_many_pixels" };
    const attempts = [
      ...JPEG_QUALITIES.map((quality) => ({ longSide: VISITOR_IMAGE_LIMITS.maxLongSidePx, quality })),
      ...FALLBACK_LONG_SIDES.map((longSide) => ({ longSide, quality: JPEG_QUALITIES[JPEG_QUALITIES.length - 1] })),
    ];
    for (const attempt of attempts) {
      const { data, info } = await encode(bytes, maxInputPixels, attempt.longSide, attempt.quality);
      if (data.length <= VISITOR_IMAGE_LIMITS.maxStoredBytes) {
        return {
          kind: "normalized",
          jpeg: data,
          width: info.width,
          height: info.height,
          sha256: createHash("sha256").update(data).digest("hex"),
        };
      }
    }
    return { kind: "rejected", reason: "too_large" };
  } catch {
    // The header passed the pixel check above, so what fails here is content that does not decode.
    return { kind: "rejected", reason: "unsupported_type" };
  }
};
