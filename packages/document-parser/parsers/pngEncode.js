import { promisify } from "node:util";
import { crc32, deflate } from "node:zlib";

const deflateAsync = promisify(deflate);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Speed over size: the image is decoded and re-encoded again before anything keeps it. */
const COMPRESSION_LEVEL = 1;

/** PNG colour type and bit depth per pixel layout, with the bytes one row of `width` pixels takes. */
const LAYOUTS = {
  gray1: { colorType: 0, bitDepth: 1, rowBytes: (width) => (width + 7) >> 3 },
  rgb8: { colorType: 2, bitDepth: 8, rowBytes: (width) => width * 3 },
  rgba8: { colorType: 6, bitDepth: 8, rowBytes: (width) => width * 4 },
};

const chunk = (type, data) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(data, crc32(Buffer.from(type, "ascii"))) >>> 0, 0);
  return Buffer.concat([header, data, crc]);
};

/**
 * Wraps raw pixel rows in a PNG, so they reach the image codec as a file it reads. Rows are packed
 * with no padding beyond the byte that ends a 1-bit row; a buffer of any other length is refused.
 */
export const encodePng = async ({ width, height, layout, pixels }) => {
  const format = LAYOUTS[layout];
  if (!format || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  const rowBytes = format.rowBytes(width);
  if (pixels.length !== rowBytes * height) return null;

  const filtered = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row += 1) {
    // Filter type 0: each row is stored as it is.
    filtered[row * (rowBytes + 1)] = 0;
    filtered.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = format.bitDepth;
  header[9] = format.colorType;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", await deflateAsync(filtered, { level: COMPRESSION_LEVEL })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};
