import { createHash } from "node:crypto";

import { encodeJpegUnder } from "../../../shared/infra/images/encodeJpegUnder.js";
import { decodeGuarded } from "../../../shared/infra/images/guardedDecode.js";
import { sniffImageType } from "../../../shared/infra/images/imageSniff.js";
import { NormalizationSlots } from "../../../shared/infra/images/normalizationSlots.js";
import { VISITOR_IMAGE_LIMITS, type VisitorImageRejection, type VisitorImageSourceType } from "../domain.js";

/**
 * Visitor photos' share of the codec's process-wide pool: two decode at once, which is the whole of
 * it; a third waits up to five seconds, then is refused as busy.
 */
const DECODING_SLOTS = new NormalizationSlots(2, 5_000);

/** Only JPEG, PNG and WebP are read from a visitor. */
const VISITOR_IMAGE_TYPES: readonly VisitorImageSourceType[] = ["image/jpeg", "image/png", "image/webp"];

/** The long sides tried, at the lowest quality, when no quality fits at 1,600 px. */
const FALLBACK_LONG_SIDES = [1_200, 800] as const;

/**
 * The type a photo's first bytes say it is. Only JPEG, PNG and WebP are read; anything else,
 * including SVG and every format a decoder would otherwise try, is refused before decoding.
 */
export const sniffVisitorImageType = (bytes: Buffer): VisitorImageSourceType | null => sniffImageType(bytes, VISITOR_IMAGE_TYPES);

type NormalizedVisitorImage =
  | { readonly kind: "normalized"; readonly jpeg: Buffer; readonly width: number; readonly height: number; readonly sha256: string }
  | { readonly kind: "rejected"; readonly reason: VisitorImageRejection };

/**
 * Re-encodes an uploaded photo into what Radioso stores: a JPEG at most 1,600 pixels on its long
 * side, turned upright from its orientation tag, with no metadata (EXIF, GPS, ICC) carried over, and
 * at most 512 KB. The type comes from the magic bytes alone, and decoding stops past the pixel
 * limit. Every channel's photos go through here, including those no browser shrank first.
 */
export const normalizeVisitorImage = async (
  bytes: Buffer,
  options: { maxInputPixels?: number; slots?: NormalizationSlots } = {},
): Promise<NormalizedVisitorImage> => {
  if (bytes.length > VISITOR_IMAGE_LIMITS.maxUploadBytes) return { kind: "rejected", reason: "too_large" };
  const decoded = await decodeGuarded(
    bytes,
    {
      accepted: VISITOR_IMAGE_TYPES,
      maxInputPixels: options.maxInputPixels ?? VISITOR_IMAGE_LIMITS.maxInputPixels,
      slots: options.slots ?? DECODING_SLOTS,
    },
    (open) => encodeJpegUnder(open, {
      maxLongSidePx: VISITOR_IMAGE_LIMITS.maxLongSidePx,
      fallbackLongSidesPx: FALLBACK_LONG_SIDES,
      maxBytes: VISITOR_IMAGE_LIMITS.maxStoredBytes,
    }),
  );
  // Pixels that do not decode past a readable header are, to a visitor, a type Radioso does not read.
  if (decoded.kind === "rejected") return { kind: "rejected", reason: decoded.reason === "encode_failed" ? "unsupported_type" : decoded.reason };
  if (decoded.value.kind === "too_large") return { kind: "rejected", reason: "too_large" };
  const { jpeg, width, height } = decoded.value;
  return { kind: "normalized", jpeg, width, height, sha256: createHash("sha256").update(jpeg).digest("hex") };
};
