import type { DecodedImage, ImageCodec } from '@/lib/visitor-image-downsize'

const WHITE = '#ffffff'

const encodeWithOffscreenCanvas = async (bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | null> => {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }
  // JPEG has no alpha: a transparent PNG would otherwise come out black.
  context.fillStyle = WHITE
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

const encodeWithCanvasElement = (bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | null> => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) {
    return Promise.resolve(null)
  }
  context.fillStyle = WHITE
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/**
 * The browser's decoder and canvas. `imageOrientation: 'from-image'` applies the EXIF rotation on
 * decode, so the bitmap's size and pixels are what the visitor sees.
 */
export const browserImageCodec: ImageCodec = {
  async decode(file: Blob): Promise<DecodedImage> {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return {
      width: bitmap.width,
      height: bitmap.height,
      encodeJpeg: (width, height, quality) =>
        typeof OffscreenCanvas === 'undefined'
          ? encodeWithCanvasElement(bitmap, width, height, quality)
          : encodeWithOffscreenCanvas(bitmap, width, height, quality),
      close: () => bitmap.close(),
    }
  },
}
