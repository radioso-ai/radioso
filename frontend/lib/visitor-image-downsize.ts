/**
 * Shrinks a photo in the browser before it is uploaded, so a phone photo goes up as a few hundred
 * KB instead of several MB. The server re-encodes every upload itself and stays the authority on
 * type and size; this only saves the visitor the upload. Anything that goes wrong here uploads the
 * original instead.
 *
 * The decoding and canvas work sit behind `ImageCodec` (see `visitor-image-browser-codec.ts`), so
 * the sizing rules and the fallbacks run without a browser.
 */

/** The long side the server stores at most, so a larger photo has nothing more to give. */
export const VISITOR_IMAGE_MAX_LONG_SIDE_PX = 1600
export const VISITOR_IMAGE_JPEG_QUALITY = 0.85
/** A file this small is already what the downsizer would produce; decoding it would cost more than it saves. */
export const VISITOR_IMAGE_SKIP_BYTES = 256 * 1024

export interface DecodedImage {
  /** The size as the visitor sees it, after the EXIF orientation is applied. */
  width: number
  height: number
  /** Draws the image at the given size on a white background and encodes it; null when the canvas gave nothing. */
  encodeJpeg(width: number, height: number, quality: number): Promise<Blob | null>
  close(): void
}

export interface ImageCodec {
  decode(file: Blob): Promise<DecodedImage>
}

/** The size within `maxLongSide` on its long side, in whole pixels; an image is never scaled up. */
export const fitWithin = (width: number, height: number, maxLongSide: number): { width: number; height: number } => {
  const longSide = Math.max(width, height)
  if (longSide <= maxLongSide) {
    return { width, height }
  }
  const scale = maxLongSide / longSide
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

const FALLBACK_BASE_NAME = 'photo'

const jpegFileName = (name: string): string => {
  const base = name.replace(/\.[^./\\]+$/, '')
  return `${base || FALLBACK_BASE_NAME}.jpg`
}

const encodeSmaller = async (file: File, decoded: DecodedImage): Promise<File> => {
  const target = fitWithin(decoded.width, decoded.height, VISITOR_IMAGE_MAX_LONG_SIDE_PX)
  const blob = await decoded.encodeJpeg(target.width, target.height, VISITOR_IMAGE_JPEG_QUALITY)
  if (!blob || blob.size >= file.size) {
    return file
  }
  return new File([blob], jpegFileName(file.name), { type: 'image/jpeg', lastModified: file.lastModified })
}

/**
 * The file to upload: the photo re-encoded as a JPEG of at most 1600 px on its long side, or the
 * original when it is already small, cannot be decoded here, or would not get smaller.
 */
export const downsizeVisitorImage = async (file: File, codec: ImageCodec): Promise<File> => {
  if (file.size <= VISITOR_IMAGE_SKIP_BYTES) {
    return file
  }
  let decoded: DecodedImage
  try {
    decoded = await codec.decode(file)
  } catch {
    return file
  }
  try {
    return await encodeSmaller(file, decoded)
  } catch {
    return file
  } finally {
    decoded.close()
  }
}
