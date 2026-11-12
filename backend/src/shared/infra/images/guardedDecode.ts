import sharp, { type Metadata, type Sharp } from "sharp";

import { sniffImageType, type ImageSourceType } from "./imageSniff.js";
import { NormalizationSlots } from "./normalizationSlots.js";

// libvips takes its threads from libuv's pool (four by default), shared with dns, fs and zlib: one
// thread per image leaves the rest of the process room, and no cache keeps anyone's pixels.
sharp.concurrency(1);
sharp.cache(false);

/**
 * At most two images decode at once in this process, whichever caller asks. libuv's pool has four
 * threads unless UV_THREADPOOL_SIZE says otherwise, and dns, fs and zlib need the other two.
 */
const PROCESS_DECODE_SLOTS = new NormalizationSlots(2, 5_000);

/** What a caller lets in: the types it reads, how many pixels decoding may reach, and optionally its own slot pool. */
export interface DecodeGuard<T extends ImageSourceType> {
  readonly accepted: readonly T[];
  readonly maxInputPixels: number;
  /**
   * A caller's share of the process-wide pool, for fairness: its images wait here first, then for
   * a process slot, within this pool's wait. It never lets the process decode more than two at once.
   */
  readonly slots?: NormalizationSlots;
}

/**
 * Why an image was not decoded. `busy` is a pool staying full past its wait, not the image.
 * `encode_failed` is an image whose header read and passed every check, but whose pixels did not
 * decode or whose output the encoder could not write.
 */
type DecodeRejection = "unsupported_type" | "too_many_pixels" | "busy" | "encode_failed";

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
 * pool, when it brings one, and then in the process-wide pool.
 */
export const decodeGuarded = async <T extends ImageSourceType, R>(
  bytes: Buffer,
  guard: DecodeGuard<T>,
  encode: (open: OpenUprightImage, type: T) => Promise<R>,
): Promise<GuardedDecode<R>> => {
  const type = sniffImageType(bytes, guard.accepted);
  if (!type) return rejected("unsupported_type");
  const decoded = await inDecodeSlots(guard.slots, () => decodeWithin(bytes, type, guard.maxInputPixels, encode));
  return decoded === "busy" ? rejected("busy") : decoded;
};

/** The caller's pool first, then the process's, on one deadline: no caller waits longer than its own pool allows. */
const inDecodeSlots = async <R>(callerSlots: NormalizationSlots | undefined, work: () => Promise<R>): Promise<R | "busy"> => {
  if (!callerSlots) return PROCESS_DECODE_SLOTS.run(work);
  const deadline = Date.now() + callerSlots.waitMs;
  return callerSlots.run(() => PROCESS_DECODE_SLOTS.run(work, { waitMs: Math.max(0, deadline - Date.now()) }));
};

const decodeWithin = async <T extends ImageSourceType, R>(
  bytes: Buffer,
  type: T,
  maxInputPixels: number,
  encode: (open: OpenUprightImage, type: T) => Promise<R>,
): Promise<GuardedDecode<R>> => {
  const headerRejection = await checkHeader(bytes, type, maxInputPixels);
  if (headerRejection) return rejected(headerRejection);
  const open: OpenUprightImage = () => sharp(bytes, { limitInputPixels: maxInputPixels, failOn: "error" }).rotate();
  try {
    return { kind: "decoded", value: await encode(open, type) };
  } catch {
    return rejected("encode_failed");
  }
};

/** The header alone: the type must agree, and the size is checked against the same limit decoding then enforces. */
const checkHeader = async (bytes: Buffer, type: ImageSourceType, maxInputPixels: number): Promise<DecodeRejection | null> => {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: false }).metadata();
    if (!decodesAs(type, metadata)) return "unsupported_type";
    return (metadata.width ?? 0) * (metadata.height ?? 0) > maxInputPixels ? "too_many_pixels" : null;
  } catch {
    // A header that does not read is not an image of the type its magic bytes name.
    return "unsupported_type";
  }
};
