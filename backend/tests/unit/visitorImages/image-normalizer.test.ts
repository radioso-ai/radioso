import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { normalizeVisitorImage, sniffVisitorImageType } from "../../../src/modules/visitorImages/services/imageNormalizer.js";
import { VISITOR_IMAGE_LIMITS } from "../../../src/modules/visitorImages/domain.js";

/** A solid image of the given size and format, made in the test so no fixture file is needed. */
const solid = (width: number, height: number, format: "jpeg" | "png" | "webp", options: { alpha?: boolean } = {}): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: options.alpha ? 4 : 3,
      background: options.alpha ? { r: 200, g: 40, b: 40, alpha: 0.5 } : { r: 200, g: 40, b: 40 },
    },
  })[format]().toBuffer();

/** Noise compresses badly, so it pushes the encoder toward the stored-size cap. */
const noise = (width: number, height: number): Promise<Buffer> => {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let index = 0; index < pixels.length; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    pixels[index] = seed & 0xff;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
};

describe("sniffVisitorImageType", () => {
  it("reads JPEG, PNG and WebP from their magic bytes", async () => {
    expect(sniffVisitorImageType(await solid(4, 4, "jpeg"))).toBe("image/jpeg");
    expect(sniffVisitorImageType(await solid(4, 4, "png"))).toBe("image/png");
    expect(sniffVisitorImageType(await solid(4, 4, "webp"))).toBe("image/webp");
  });

  it("refuses anything else, whatever a caller declared", async () => {
    expect(sniffVisitorImageType(Buffer.from("GIF89a\u0001\u0000\u0001\u0000"))).toBeNull();
    expect(sniffVisitorImageType(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"))).toBeNull();
    expect(sniffVisitorImageType(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).tiff().toBuffer())).toBeNull();
    expect(sniffVisitorImageType(Buffer.alloc(0))).toBeNull();
    expect(sniffVisitorImageType(Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"))).toBeNull();
  });
});

describe("normalizeVisitorImage", () => {
  it("re-encodes a large photo to a JPEG whose long side is at most 1600 pixels", async () => {
    const result = await normalizeVisitorImage(await solid(4000, 2000, "png"));

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") return;
    expect(sniffVisitorImageType(result.jpeg)).toBe("image/jpeg");
    expect(result.width).toBe(1600);
    expect(result.height).toBe(800);
    const stored = await sharp(result.jpeg).metadata();
    expect(stored.format).toBe("jpeg");
    expect(stored.width).toBe(1600);
    expect(result.sha256).toBe(createHash("sha256").update(result.jpeg).digest("hex"));
  });

  it("keeps a small photo's size and never enlarges it", async () => {
    const result = await normalizeVisitorImage(await solid(320, 200, "webp"));

    expect(result).toMatchObject({ kind: "normalized", width: 320, height: 200 });
  });

  it("flattens transparency onto white, since JPEG has none", async () => {
    const result = await normalizeVisitorImage(await solid(40, 40, "png", { alpha: true }));

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") return;
    expect((await sharp(result.jpeg).metadata()).hasAlpha).toBe(false);
  });

  it("turns the photo upright from its orientation tag and drops every tag it carried", async () => {
    // Orientation 6: the camera was turned a quarter, so the upright photo is taller than it is wide.
    const sideways = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#123456" } })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "Example camera" } } })
      .toBuffer();
    expect((await sharp(sideways).metadata()).exif).toBeDefined();

    const result = await normalizeVisitorImage(sideways);

    expect(result).toMatchObject({ kind: "normalized", width: 100, height: 300 });
    if (result.kind !== "normalized") return;
    const stored = await sharp(result.jpeg).metadata();
    expect(stored.exif).toBeUndefined();
    expect(stored.orientation).toBeUndefined();
  });

  it("steps quality down until the stored file fits the stored-size cap", async () => {
    const result = await normalizeVisitorImage(await noise(1600, 1200));

    expect(result.kind).toBe("normalized");
    if (result.kind !== "normalized") return;
    expect(result.jpeg.length).toBeLessThanOrEqual(VISITOR_IMAGE_LIMITS.maxStoredBytes);
  });

  it("refuses a type it does not read, before decoding anything", async () => {
    expect(await normalizeVisitorImage(Buffer.from("GIF89a\u0001\u0000\u0001\u0000"))).toEqual({ kind: "rejected", reason: "unsupported_type" });
  });

  it("refuses bytes that claim a supported type but do not decode", async () => {
    const truncated = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not a png")]);

    expect(await normalizeVisitorImage(truncated)).toEqual({ kind: "rejected", reason: "unsupported_type" });
  });

  it("refuses an upload over the raw size cap without decoding it", async () => {
    const oversized = Buffer.concat([await solid(4, 4, "jpeg"), Buffer.alloc(VISITOR_IMAGE_LIMITS.maxUploadBytes)]);

    expect(await normalizeVisitorImage(oversized)).toEqual({ kind: "rejected", reason: "too_large" });
  });

  it("refuses a photo over the pixel limit", async () => {
    const result = await normalizeVisitorImage(await solid(400, 300, "png"), { maxInputPixels: 400 * 300 - 1 });

    expect(result).toEqual({ kind: "rejected", reason: "too_many_pixels" });
  });
});
