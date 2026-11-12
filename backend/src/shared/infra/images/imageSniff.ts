/** The raster types the codec reads, each named by its magic bytes. */
export type ImageSourceType = "image/jpeg" | "image/png" | "image/webp";

/**
 * The type an image's first bytes say it is, when the caller accepts that type. Whatever a caller
 * or a server declared is ignored, and anything else, including SVG and every format a decoder
 * would otherwise try, is refused before decoding.
 */
export const sniffImageType = <T extends ImageSourceType>(bytes: Buffer, accepted: readonly T[]): T | null => {
  const type = magicType(bytes);
  return type !== null && (accepted as readonly ImageSourceType[]).includes(type) ? type as T : null;
};

const magicType = (bytes: Buffer): ImageSourceType | null => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
