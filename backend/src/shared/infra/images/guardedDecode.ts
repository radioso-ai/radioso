import sharp, { type Metadata, type Sharp } from "sharp";

import { sniffImageType, type ImageSourceType } from "./imageSniff.js";
import type { NormalizationSlots } from "./normalizationSlots.js";

// libvips takes its threads from libuv's pool (four by default), shared with dns, fs and zlib: one
// thread per image leaves the rest of the process room, and no cache keeps anyone's pixels.
sharp.concurrency(1);
sharp.cache(false);

/** What a caller lets in: the types it reads, how many pixels decoding may reach, and its own slot pool. */
export interface DecodeGuard<T extends ImageSourceType> {
  readonly accepted: readonly T[];
  readonly maxInputPixels: number;
  /** Each caller holds its own pool, so one caller's burst cannot starve another's. */
  readonly slots: NormalizationSlots;
}

/** Why an image was not decoded. `busy` is the caller's pool staying full past its wait, not the image. */
type DecodeRejection = "unsupported_type" | "too_many_pixels" | "busy";

/** Opens a fresh pipeline over the image, turned upright from its orientation tag, decoding no more pixels than the guard allows. */
export type OpenUprightImage = () => Sharp;

type GuardedDecode<R> =
  | { readonly kind: "decoded"; readonly value: R }
  | { readonly kind: "rejected"; readonly reason: DecodeRejection };

/** The decoder's own name for each type it may read, so a file whose content disagrees with its magic bytes is refused. */
const DECODED_FORMAT: Readonly<Record<ImageSourceType, { readonly format: string; readonly compression?: string }>> = {
  "image/jpeg": { format: "jpeg" },
  "image/png": { format: "png" },
  "image/webp": { format: "webp" },
  // A GIF decodes to its first frame only: no page count is asked for.
  "image/gif": { format: "gif" },
  // libvips reads AVIF through libheif, which reads HEIC too; the compression tells them apart.
  "image/avif": { format: "heif", compression: "av1" },
};

const decodesAs = (type: ImageSourceType, metadata: Metadata): boolean => {
  const expected = DECODED_FORMAT[type];
  return metadata.format === expected.format && (expected.compression === undefined || metadata.compression === expected.compression);
};

const rejected = (reason: DecodeRejection): GuardedDecode<never> => ({ kind: "rejected", reason });

/**
 * Hands `encode` an image that is safe to decode: its type comes from the magic bytes alone and
 * must be one the caller accepts, the decoder must agree with that type, and the header's pixel
 * count must be within the limit decoding then enforces. Decoding waits for a slot in the caller's
 * pool. Content that does not decode, at any step, is `unsupported_type`.
 */
export const decodeGuarded = async <T extends ImageSourceType, R>(
  bytes: Buffer,
  guard: DecodeGuard<T>,
  encode: (open: OpenUprightImage, type: T) => Promise<R>,
): Promise<GuardedDecode<R>> => {
  const type = sniffImageType(bytes, guard.accepted);
  if (!type) return rejected("unsupported_type");
  const decoded = await guard.slots.run(() => decodeWithin(bytes, type, guard.maxInputPixels, encode));
  return decoded === "busy" ? rejected("busy") : decoded;
};

const decodeWithin = async <T extends ImageSourceType, R>(
  bytes: Buffer,
  type: T,
  maxInputPixels: number,
  encode: (open: OpenUprightImage, type: T) => Promise<R>,
): Promise<GuardedDecode<R>> => {
  try {
    // The header alone: the size is checked here, against the same limit decoding then enforces.
    const metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    if (!decodesAs(type, metadata)) return rejected("unsupported_type");
    if ((metadata.width ?? 0) * (metadata.height ?? 0) > maxInputPixels) return rejected("too_many_pixels");
    const open: OpenUprightImage = () => sharp(bytes, { limitInputPixels: maxInputPixels, failOn: "error" }).rotate();
    return { kind: "decoded", value: await encode(open, type) };
  } catch {
    // The header passed the pixel check above, so what fails here is content that does not decode.
    return rejected("unsupported_type");
  }
};
