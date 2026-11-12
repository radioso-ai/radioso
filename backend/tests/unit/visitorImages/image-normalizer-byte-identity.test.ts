import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeVisitorImage } from "../../../src/modules/visitorImages/services/imageNormalizer.js";

/**
 * The visitor chain as it stood before the codec moved to `shared/infra/images`, copied here as
 * the oracle: the shared codec must produce the same bytes for every visitor photo.
 */
const ORIGINAL_MAX_INPUT_PIXELS = 50_000_000;
const ORIGINAL_MAX_STORED_BYTES = 512 * 1024;
const ORIGINAL_MAX_LONG_SIDE = 1_600;
const ORIGINAL_JPEG_QUALITIES = [85, 75, 65, 55, 45] as const;
const ORIGINAL_FALLBACK_LONG_SIDES = [1_200, 800] as const;

const originalEncode = (bytes: Buffer, longSide: number, quality: number) =>
  sharp(bytes, { limitInputPixels: ORIGINAL_MAX_INPUT_PIXELS, failOn: "error" })
    .rotate()
    .resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });

const originalNormalize = async (bytes: Buffer): Promise<{ jpeg: Buffer; width: number; height: number } | null> => {
  const attempts = [
    ...ORIGINAL_JPEG_QUALITIES.map((quality) => ({ longSide: ORIGINAL_MAX_LONG_SIDE, quality })),
    ...ORIGINAL_FALLBACK_LONG_SIDES.map((longSide) => ({ longSide, quality: ORIGINAL_JPEG_QUALITIES[ORIGINAL_JPEG_QUALITIES.length - 1] })),
  ];
  for (const attempt of attempts) {
    const { data, info } = await originalEncode(bytes, attempt.longSide, attempt.quality);
    if (data.length <= ORIGINAL_MAX_STORED_BYTES) return { jpeg: data, width: info.width, height: info.height };
  }
  return null;
};

const solid = (width: number, height: number, format: "jpeg" | "png" | "webp", options: { alpha?: boolean } = {}): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: options.alpha ? 4 : 3,
      background: options.alpha ? { r: 30, g: 120, b: 200, alpha: 0.4 } : { r: 30, g: 120, b: 200 },
    },
  })[format]().toBuffer();

/** Noise compresses badly, so the encoder steps quality down to fit. */
const noise = (width: number, height: number): Promise<Buffer> => {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 11;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    pixels[index] = seed & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
};

const rotatedJpeg = (): Promise<Buffer> =>
  sharp({ create: { width: 600, height: 200, channels: 3, background: "#654321" } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "Example camera" } } })
    .toBuffer();

describe("normalizeVisitorImage against the pre-extraction chain", () => {
  it.each([
    ["a JPEG", () => solid(800, 600, "jpeg")],
    ["a PNG with transparency", () => solid(300, 300, "png", { alpha: true })],
    ["a WebP", () => solid(320, 200, "webp")],
    ["a JPEG turned by its EXIF orientation", rotatedJpeg],
    ["a large PNG, shrunk to 1,600 px", () => solid(4000, 2000, "png")],
    ["a noisy photo, stepped down in quality", () => noise(1600, 1200)],
  ] as const)("produces the same bytes for %s", async (_name, make) => {
    const input = await make();
    const expected = await originalNormalize(input);
    expect(expected).not.toBeNull();

    const result = await normalizeVisitorImage(input);

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized" || !expected) return;
    expect(result.jpeg.equals(expected.jpeg)).toBe(true);
    expect({ width: result.width, height: result.height }).toEqual({ width: expected.width, height: expected.height });
  });

  it("still refuses as unsupported_type a photo whose header reads but whose pixels do not", async () => {
    const whole = await solid(400, 300, "jpeg");
    const truncated = whole.subarray(0, Math.floor(whole.length / 2));

    await expect(originalEncode(truncated, ORIGINAL_MAX_LONG_SIDE, 85)).rejects.toThrow();
    expect(await normalizeVisitorImage(truncated)).toEqual({ kind: "rejected", reason: "unsupported_type" });
  });
});
