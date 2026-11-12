import { describe, expect, it, vi } from 'vitest'

import {
  VISITOR_IMAGE_JPEG_QUALITY,
  VISITOR_IMAGE_MAX_LONG_SIDE_PX,
  VISITOR_IMAGE_SKIP_BYTES,
  downsizeVisitorImage,
  fitWithin,
  type DecodedImage,
  type ImageCodec,
} from '@/lib/visitor-image-downsize'

const fileOf = (bytes: number, name = 'IMG_0001.HEIC.jpg', type = 'image/jpeg') =>
  new File([new Uint8Array(bytes)], name, { type, lastModified: 1_700_000_000_000 })

const codecOf = (decoded: Partial<DecodedImage> & { width: number; height: number }, encodedBytes: number | null = 100_000) => {
  const encodeJpeg = vi.fn(async () => (encodedBytes === null ? null : new Blob([new Uint8Array(encodedBytes)], { type: 'image/jpeg' })))
  const close = vi.fn()
  const decode = vi.fn(async () => ({ encodeJpeg, close, ...decoded }))
  const codec: ImageCodec = { decode }
  return { codec, decode, encodeJpeg, close }
}

describe('fitWithin', () => {
  it('scales the long side down to the limit and keeps the proportions', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(3024, 4032, 1600)).toEqual({ width: 1200, height: 1600 })
  })

  it('never scales an image up', () => {
    expect(fitWithin(800, 600, 1600)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(1600, 1600, 1600)).toEqual({ width: 1600, height: 1600 })
  })

  it('keeps at least one pixel on the short side of a very narrow image', () => {
    expect(fitWithin(10_000, 3, 1600)).toEqual({ width: 1600, height: 1 })
  })
})

describe('downsizeVisitorImage', () => {
  it('re-encodes a large photo as a JPEG with a long side of at most 1600 px at about 0.85 quality', async () => {
    const { codec, encodeJpeg, close } = codecOf({ width: 4032, height: 3024 }, 280_000)
    const original = fileOf(4_500_000, 'IMG_0001.HEIC.png', 'image/png')

    const result = await downsizeVisitorImage(original, codec)

    expect(encodeJpeg).toHaveBeenCalledWith(VISITOR_IMAGE_MAX_LONG_SIDE_PX, 1200, VISITOR_IMAGE_JPEG_QUALITY)
    expect(VISITOR_IMAGE_MAX_LONG_SIDE_PX).toBe(1600)
    expect(VISITOR_IMAGE_JPEG_QUALITY).toBeCloseTo(0.85)
    expect(result).not.toBe(original)
    expect(result.type).toBe('image/jpeg')
    expect(result.size).toBe(280_000)
    expect(result.name).toBe('IMG_0001.HEIC.jpg')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uploads a file that is already small as it is, without decoding it', async () => {
    const { codec, decode } = codecOf({ width: 1000, height: 800 })
    const small = fileOf(VISITOR_IMAGE_SKIP_BYTES)

    const result = await downsizeVisitorImage(small, codec)

    expect(result).toBe(small)
    expect(decode).not.toHaveBeenCalled()
  })

  it('keeps the original when re-encoding would not make it smaller', async () => {
    const { codec, close } = codecOf({ width: 1500, height: 1000 }, 900_000)
    const original = fileOf(600_000)

    const result = await downsizeVisitorImage(original, codec)

    expect(result).toBe(original)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uploads the original and lets the server decide when the browser cannot decode it', async () => {
    const decode = vi.fn(async () => {
      throw new Error('The source image cannot be decoded')
    })
    const original = fileOf(3_000_000)

    await expect(downsizeVisitorImage(original, { decode })).resolves.toBe(original)
  })

  it('uploads the original when the canvas produces no blob', async () => {
    const { codec, close } = codecOf({ width: 3000, height: 2000 }, null)
    const original = fileOf(3_000_000)

    await expect(downsizeVisitorImage(original, codec)).resolves.toBe(original)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('uploads the original when encoding throws, and still releases the decoded image', async () => {
    const { codec, encodeJpeg, close } = codecOf({ width: 3000, height: 2000 })
    encodeJpeg.mockRejectedValueOnce(new Error('canvas lost'))
    const original = fileOf(3_000_000)

    await expect(downsizeVisitorImage(original, codec)).resolves.toBe(original)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('names the result with a .jpg extension whatever the original was called', async () => {
    const { codec } = codecOf({ width: 3000, height: 2000 }, 200_000)

    expect((await downsizeVisitorImage(fileOf(2_000_000, 'photo.webp', 'image/webp'), codec)).name).toBe('photo.jpg')
    expect((await downsizeVisitorImage(fileOf(2_000_000, 'noextension', 'image/png'), codec)).name).toBe('noextension.jpg')
    expect((await downsizeVisitorImage(fileOf(2_000_000, '', 'image/png'), codec)).name).toBe('photo.jpg')
  })
})
