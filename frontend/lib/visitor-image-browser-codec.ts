import type { DecodedImage, ImageCodec } from '@/lib/visitor-image-downsize'

const WHITE = '#ffffff'

/**
 * Paints the bitmap on the canvas at the target size, and lets the full-size bitmap go as soon as
 * it is painted: it is the largest thing in memory, and a phone holds few of them.
 */
const paint = (
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  width: number,
  height: number,
): void => {
  // JPEG has no alpha: a transparent PNG would otherwise come out black.
  context.fillStyle = WHITE
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
}

const encodeWithOffscreenCanvas = async (bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | null> => {
  const canvas = new OffscreenCanvas(width, height)
  try {
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    paint(context, bitmap, width, height)
    return await canvas.convertToBlob({ type: 'image/jpeg', quality })
  } finally {
    // Safari keeps a canvas's pixels until its size is reset, and a few photos' worth is a crash.
    canvas.width = 0
    canvas.height = 0
  }
}

const encodeWithCanvasElement = async (bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob | null> => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  try {
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    paint(context, bitmap, width, height)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
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
