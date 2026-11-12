import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { encodeWebpRenditions } from "../../../../src/shared/infra/images/encodeWebpRenditions.js";
import { decodeGuarded, type DecodeGuard, type OpenUprightImage } from "../../../../src/shared/infra/images/guardedDecode.js";
import { sniffImageType, type ImageSourceType } from "../../../../src/shared/infra/images/imageSniff.js";
import { NormalizationSlots } from "../../../../src/shared/infra/images/normalizationSlots.js";

const EVERY_TYPE: readonly ImageSourceType[] = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const VISITOR_TYPES: readonly ImageSourceType[] = ["image/jpeg", "image/png", "image/webp"];

/** A solid image of the given size and format, made in the test so no fixture file is needed. */
const solid = (
  width: number,
  height: number,
  format: "jpeg" | "png" | "webp" | "gif" | "avif",
  color = "#c82828",
  options: { alpha?: boolean } = {},
): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: options.alpha ? 4 : 3,
      background: options.alpha ? { r: 200, g: 40, b: 40, alpha: 0.5 } : color,
    },
  })[format]().toBuffer();

/** An animated GIF whose first frame is red and second blue. */
const animatedGif = async (): Promise<Buffer> => {
  const frame = (color: string) => sharp({ create: { width: 20, height: 10, channels: 4, background: color } }).png().toBuffer();
  return sharp([await frame("#ff0000"), await frame("#0000ff")], { join: { animated: true } }).gif().toBuffer();
};

/** The first pixel's red, green and blue. */
const firstPixel = async (image: Buffer): Promise<number[]> => {
  const { data } = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return [data[0], data[1], data[2]];
};

/** An ISO-BMFF `ftyp` box naming its major brand and compatible brands, as AVIF and HEIC files open. */
const ftyp = (major: string, compatible: string[]): Buffer => {
  const size = 16 + compatible.length * 4;
  const box = Buffer.alloc(size);
  box.writeUInt32BE(size, 0);
  box.write("ftyp", 4, "latin1");
  box.write(major, 8, "latin1");
  compatible.forEach((brand, index) => box.write(brand, 16 + index * 4, "latin1"));
  return box;
};

const guard = (accepted: readonly ImageSourceType[], overrides: Partial<DecodeGuard<ImageSourceType>> = {}): DecodeGuard<ImageSourceType> => ({
  accepted,
  maxInputPixels: 50_000_000,
  slots: new NormalizationSlots(2, 1_000),
  ...overrides,
});

const renditions = (bytes: Buffer, accepted: readonly ImageSourceType[] = EVERY_TYPE, widthsPx: readonly number[] = [320, 640]) =>
  decodeGuarded(bytes, guard(accepted), (open) => encodeWebpRenditions(open, { widthsPx }));

describe("sniffImageType", () => {
  it.each([
    ["image/jpeg", () => solid(4, 4, "jpeg")],
    ["image/png", () => solid(4, 4, "png")],
    ["image/webp", () => solid(4, 4, "webp")],
    ["image/gif", () => solid(4, 4, "gif")],
    ["image/avif", () => solid(4, 4, "avif")],
  ] as const)("reads %s from its magic bytes when the caller accepts it", async (type, make) => {
    expect(sniffImageType(await make(), EVERY_TYPE)).toBe(type);
  });

  it("reads AVIF from a compatible brand when the major brand is generic", () => {
    expect(sniffImageType(ftyp("mif1", ["mif1", "avif", "miaf"]), EVERY_TYPE)).toBe("image/avif");
    expect(sniffImageType(ftyp("avis", ["avis", "msf1"]), EVERY_TYPE)).toBe("image/avif");
  });

  it("reads no further than a real ftyp box, whatever size the file declares", () => {
    // 10 MB that declares an ftyp box of 4 GB and names no AVIF brand: only the first bytes are read.
    const crafted = Buffer.alloc(10 * 1024 * 1024);
    crafted.writeUInt32BE(0xffffffff, 0);
    crafted.write("ftypmif1", 4, "latin1");
    const startedAt = performance.now();

    expect(sniffImageType(crafted, EVERY_TYPE)).toBeNull();
    expect(sniffImageType(crafted, VISITOR_TYPES)).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(25);
  });

  it("finds an AVIF brand near the start of the box, and none past it", () => {
    const declaredHuge = ftyp("mif1", ["mif1", "miaf", "avif"]);
    declaredHuge.writeUInt32BE(0xffffffff, 0);
    const brandFarIn = Buffer.alloc(256);
    brandFarIn.writeUInt32BE(256, 0);
    brandFarIn.write("ftypmif1", 4, "latin1");
    brandFarIn.write("avif", 200, "latin1");

    expect(sniffImageType(declaredHuge, EVERY_TYPE)).toBe("image/avif");
    expect(sniffImageType(brandFarIn, EVERY_TYPE)).toBeNull();
  });

  it("refuses GIF and AVIF unless the caller accepts them", async () => {
    expect(sniffImageType(await solid(4, 4, "gif"), VISITOR_TYPES)).toBeNull();
    expect(sniffImageType(await solid(4, 4, "avif"), VISITOR_TYPES)).toBeNull();
  });

  it("refuses SVG, HEIC and every other format even when every type is accepted", async () => {
    expect(sniffImageType(Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), EVERY_TYPE)).toBeNull();
    expect(sniffImageType(Buffer.from("<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\"/>"), EVERY_TYPE)).toBeNull();
    expect(sniffImageType(ftyp("heic", ["mif1", "heic"]), EVERY_TYPE)).toBeNull();
    expect(sniffImageType(ftyp("mif1", ["mif1", "heic"]), EVERY_TYPE)).toBeNull();
    expect(sniffImageType(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).tiff().toBuffer(), EVERY_TYPE)).toBeNull();
    expect(sniffImageType(Buffer.from("GIF90a"), EVERY_TYPE)).toBeNull();
    expect(sniffImageType(Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVE"), EVERY_TYPE)).toBeNull();
    expect(sniffImageType(Buffer.alloc(0), EVERY_TYPE)).toBeNull();
  });
});

describe("decodeGuarded", () => {
  it("decodes only the first frame of an animated GIF", async () => {
    const result = await renditions(await animatedGif(), EVERY_TYPE, [320]);

    expect(result.kind).toBe("decoded");
    if (result.kind !== "decoded") return;
    expect(result.value[0]).toMatchObject({ width: 20, height: 10 });
    // Red, give or take what lossy WebP shifts; the second frame is blue.
    const [red, , blue] = await firstPixel(result.value[0].webp);
    expect(red).toBeGreaterThan(240);
    expect(blue).toBeLessThan(16);
  });

  it("decodes AVIF when the caller accepts it", async () => {
    const result = await renditions(await solid(800, 400, "avif"), ["image/avif"], [320]);

    expect(result).toMatchObject({ kind: "decoded", value: [{ width: 320, height: 160 }] });
  });

  it("refuses GIF and AVIF for a caller that reads only JPEG, PNG and WebP, before decoding", async () => {
    expect(await renditions(await solid(40, 30, "gif"), VISITOR_TYPES)).toEqual({ kind: "rejected", reason: "unsupported_type" });
    expect(await renditions(await solid(40, 30, "avif"), VISITOR_TYPES)).toEqual({ kind: "rejected", reason: "unsupported_type" });
  });

  it("refuses polyglots: magic bytes of one type over content of another", async () => {
    const svg = Buffer.from("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"40\" height=\"40\"/>");
    const pngOverSvg = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), svg]);
    const gifOverSvg = Buffer.concat([Buffer.from("GIF89a"), svg]);
    const avifOverPng = Buffer.concat([ftyp("avif", ["avif", "mif1"]), await solid(40, 40, "png")]);
    const webpOverPng = Buffer.concat([Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBP"), await solid(40, 40, "png")]);

    for (const polyglot of [pngOverSvg, gifOverSvg, avifOverPng, webpOverPng]) {
      expect(await renditions(polyglot)).toEqual({ kind: "rejected", reason: "unsupported_type" });
    }
  });

  it("refuses a GIF over the caller's pixel limit", async () => {
    const result = await decodeGuarded(await solid(400, 300, "gif"), guard(EVERY_TYPE, { maxInputPixels: 400 * 300 - 1 }), (open) =>
      encodeWebpRenditions(open, { widthsPx: [320] }));

    expect(result).toEqual({ kind: "rejected", reason: "too_many_pixels" });
  });

  it("reports a failure after the header checks as encode_failed, not as an unsupported type", async () => {
    const refused = await decodeGuarded(await solid(40, 30, "png"), guard(EVERY_TYPE), () => Promise.reject(new Error("encoder refused")));

    expect(refused).toEqual({ kind: "rejected", reason: "encode_failed" });
  });

  it("decodes through the process-wide pool when the caller brings no pool of its own", async () => {
    const result = await decodeGuarded(await solid(40, 30, "png"), guard(EVERY_TYPE, { slots: undefined }), (open) =>
      encodeWebpRenditions(open, { widthsPx: [320] }));

    expect(result.kind).toBe("decoded");
  });

  it("never decodes more than two images at once in the process, whatever pools the callers bring", async () => {
    const image = await solid(40, 30, "png");
    const gates: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const encode = async (): Promise<string> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => gates.push(resolve));
      active -= 1;
      return "encoded";
    };
    const visitors = new NormalizationSlots(2, 5_000);
    const documents = new NormalizationSlots(2, 5_000);

    const runs = [visitors, visitors, documents, documents].map((slots) => decodeGuarded(image, guard(EVERY_TYPE, { slots }), encode));

    await expect.poll(() => active).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(active).toBe(2);
    for (let released = 0; released < runs.length; released += 1) {
      await expect.poll(() => gates.length).toBeGreaterThan(0);
      gates.shift()?.();
    }
    expect((await Promise.all(runs)).map((run) => run.kind)).toEqual(["decoded", "decoded", "decoded", "decoded"]);
    expect(peak).toBe(2);
  });

  it("waits on the caller's own slot pool, so a full pool elsewhere does not refuse it", async () => {
    const full = new NormalizationSlots(1, 1);
    let free!: () => void;
    const holding = full.run(() => new Promise<void>((resolve) => { free = resolve; }));
    const image = await solid(40, 30, "png");
    const encode = (open: OpenUprightImage) => encodeWebpRenditions(open, { widthsPx: [320] });

    expect(await decodeGuarded(image, guard(EVERY_TYPE, { slots: full }), encode)).toEqual({ kind: "rejected", reason: "busy" });
    expect((await decodeGuarded(image, guard(EVERY_TYPE), encode)).kind).toBe("decoded");

    free();
    await holding;
  });
});

describe("encodeWebpRenditions", () => {
  it("encodes one WebP per requested width, keeping the aspect ratio", async () => {
    const result = await renditions(await solid(1000, 500, "jpeg"));

    expect(result.kind).toBe("decoded");
    if (result.kind !== "decoded") return;
    expect(result.value.map(({ width, height }) => ({ width, height }))).toEqual([{ width: 320, height: 160 }, { width: 640, height: 320 }]);
    for (const rendition of result.value) {
      const stored = await sharp(rendition.webp).metadata();
      expect(stored).toMatchObject({ format: "webp", width: rendition.width, height: rendition.height });
    }
  });

  it("never enlarges an image narrower than a requested width", async () => {
    const result = await renditions(await solid(200, 100, "png"));

    expect(result).toMatchObject({ kind: "decoded", value: [{ width: 200, height: 100 }, { width: 200, height: 100 }] });
  });

  it("bounds a tall image's height to what WebP holds instead of failing the rendition", async () => {
    const tall = await solid(1080, 20_000, "png");

    const result = await renditions(tall, EVERY_TYPE, [320, 640, 1080]);

    expect(result.kind).toBe("decoded");
    if (result.kind !== "decoded") return;
    expect(result.value.map(({ width, height }) => ({ width, height }))).toEqual([
      { width: 320, height: 5926 },
      { width: 640, height: 11852 },
      { width: 885, height: 16383 },
    ]);
  });

  it("turns the image upright and carries no EXIF, ICC or XMP over", async () => {
    // Orientation 6: the camera was turned a quarter, so the upright image is taller than it is wide.
    const sideways = await sharp({ create: { width: 900, height: 300, channels: 3, background: "#123456" } })
      .jpeg()
      .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: "Example camera" } } })
      .withIccProfile("p3")
      .withXmp("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"></x:xmpmeta>")
      .toBuffer();
    const source = await sharp(sideways).metadata();
    expect(source.exif).toBeDefined();
    expect(source.icc).toBeDefined();
    expect(source.xmp).toBeDefined();

    const result = await renditions(sideways, EVERY_TYPE, [200]);

    expect(result).toMatchObject({ kind: "decoded", value: [{ width: 200, height: 600 }] });
    if (result.kind !== "decoded") return;
    const stored = await sharp(result.value[0].webp).metadata();
    expect(stored.exif).toBeUndefined();
    expect(stored.icc).toBeUndefined();
    expect(stored.xmp).toBeUndefined();
    expect(stored.orientation).toBeUndefined();
  });

  it("keeps transparency, which WebP carries", async () => {
    const result = await renditions(await solid(40, 40, "png", "#000", { alpha: true }), EVERY_TYPE, [320]);

    expect(result.kind).toBe("decoded");
    if (result.kind !== "decoded") return;
    expect((await sharp(result.value[0].webp).metadata()).hasAlpha).toBe(true);
  });
});
