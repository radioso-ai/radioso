/**
 * The raster types the codec reads, each named by its magic bytes. SVG is never one: it is markup
 * that can carry script, so no caller can accept it.
 */
export type ImageSourceType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif";

/**
 * The type an image's first bytes say it is, when the caller accepts that type. Only the accepted
 * types' signatures are tested. Whatever a caller or a server declared is ignored, and anything
 * else, including SVG and every format a decoder would otherwise try, is refused before decoding.
 */
export const sniffImageType = <T extends ImageSourceType>(bytes: Buffer, accepted: readonly T[]): T | null =>
  accepted.find((type) => SIGNATURES[type](bytes)) ?? null;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const GIF_SIGNATURES = new Set(["GIF87a", "GIF89a"]);
/** AVIF still images and sequences. HEIC shares the container and is not among them. */
const AVIF_BRANDS = new Set(["avif", "avis"]);
/**
 * How far into an `ftyp` box brands are read. Real boxes hold a handful of brands in a few dozen
 * bytes; the size a file declares is not trusted, so a crafted one cannot make the scan long.
 */
const FTYP_SCAN_BYTES = 64;

/**
 * An ISO-BMFF file opens with an `ftyp` box: its size, `ftyp`, a major brand, a minor version, then
 * compatible brands to the end of the box. AVIF is named by the major brand or, under a generic
 * major brand such as `mif1`, by a compatible one.
 */
const isAvif = (bytes: Buffer): boolean => {
  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") return false;
  if (AVIF_BRANDS.has(bytes.toString("latin1", 8, 12))) return true;
  const scanEnd = Math.min(bytes.readUInt32BE(0), bytes.length, FTYP_SCAN_BYTES);
  for (let offset = 16; offset + 4 <= scanEnd; offset += 4) {
    if (AVIF_BRANDS.has(bytes.toString("latin1", offset, offset + 4))) return true;
  }
  return false;
};

const SIGNATURES: Readonly<Record<ImageSourceType, (bytes: Buffer) => boolean>> = {
  "image/jpeg": (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  "image/png": (bytes) => bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
  "image/webp": (bytes) => bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP",
  "image/gif": (bytes) => bytes.length >= 6 && GIF_SIGNATURES.has(bytes.toString("latin1", 0, 6)),
  "image/avif": isAvif,
};
