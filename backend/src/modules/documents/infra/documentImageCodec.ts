import { fetchPublicBytes, type PublicBytesFetchResult } from "../../../shared/infra/http/publicBytesFetch.js";
import { encodeWebpRenditions } from "../../../shared/infra/images/encodeWebpRenditions.js";
import { decodeGuarded } from "../../../shared/infra/images/guardedDecode.js";
import type { ImageSourceType } from "../../../shared/infra/images/imageSniff.js";
import { NormalizationSlots } from "../../../shared/infra/images/normalizationSlots.js";
import { DOCUMENT_IMAGE_RENDITION_WIDTHS } from "../contracts/documentImages.js";
import type {
  DocumentImageEncoder,
  DocumentImageFetcher,
  EncodedDocumentImage,
} from "../services/documentImageCaptureService.js";

/** Every raster type the codec reads; SVG never is one. */
const DOCUMENT_IMAGE_TYPES: readonly ImageSourceType[] = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
/** A 48-megapixel photo decodes; a decompression bomb's header is refused before it does. */
const MAX_INPUT_PIXELS = 50_000_000;
/** One fetch, redirects and body together. */
const FETCH_TIMEOUT_MS = 8_000;
/** Well above a large photo or a long GIF; the body is cut off past it. */
const MAX_SOURCE_BYTES = 15 * 1024 * 1024;

/**
 * Document images take one of the codec's process-wide slots and wait for it patiently: capture runs
 * in the background, so it yields to visitors' photos rather than competing with them.
 */
const DOCUMENT_DECODE_SLOTS = new NormalizationSlots(1, 30_000);

/** Fetches an image a document names through the public-network policy, conditionally when an entity tag is known. */
export const fetchDocumentImage: DocumentImageFetcher = (url, options): Promise<PublicBytesFetchResult> =>
  fetchPublicBytes(url, {
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_SOURCE_BYTES,
    accept: "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1",
    ...(options.ifNoneMatch ? { ifNoneMatch: options.ifNoneMatch } : {}),
  });

/** An EXIF orientation of 5 to 8 turns the image a quarter: its upright width is its stored height. */
const QUARTER_TURN_ORIENTATIONS = new Set([5, 6, 7, 8]);

/**
 * Decodes an image under the pixel cap and re-encodes it to WebP at every rendition width, after
 * checking its upright short side against the caller's floor. No metadata is carried over.
 */
export const encodeDocumentImage: DocumentImageEncoder = async (bytes, options): Promise<EncodedDocumentImage> => {
  const decoded = await decodeGuarded(
    bytes,
    { accepted: DOCUMENT_IMAGE_TYPES, maxInputPixels: MAX_INPUT_PIXELS, slots: DOCUMENT_DECODE_SLOTS },
    async (open): Promise<EncodedDocumentImage> => {
      const metadata = await open().metadata();
      const turned = QUARTER_TURN_ORIENTATIONS.has(metadata.orientation ?? 1);
      const width = (turned ? metadata.height : metadata.width) ?? 0;
      const height = (turned ? metadata.width : metadata.height) ?? 0;
      if (Math.min(width, height) < options.minShortSidePx) {
        return { kind: "refused", reason: "too_small" };
      }
      const renditions = await encodeWebpRenditions(open, { widthsPx: DOCUMENT_IMAGE_RENDITION_WIDTHS });
      return {
        kind: "encoded",
        width,
        height,
        renditions: renditions.map((rendition, index) => ({ ...rendition, slotWidth: DOCUMENT_IMAGE_RENDITION_WIDTHS[index] ?? rendition.width })),
      };
    },
  );
  if (decoded.kind === "decoded") return decoded.value;
  switch (decoded.reason) {
    case "unsupported_type": return { kind: "refused", reason: "unsupported_type" };
    case "too_many_pixels": return { kind: "refused", reason: "too_large" };
    case "busy": return { kind: "refused", reason: "busy" };
    case "encode_failed": return { kind: "refused", reason: "decode_error" };
  }
};
