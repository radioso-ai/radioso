import { DocumentParserError } from "../errors.js";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP64_SIZE = 0xffffffff;
const MAX_EOCD_SEARCH_BYTES = 65_557;

export const DEFAULT_OFFICE_ARCHIVE_LIMITS = {
  maxCompressionRatio: 200,
  maxEntries: 2_000,
  maxEntryUncompressedBytes: 25 * 1024 * 1024,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,
};

const fail = (message) => {
  throw new DocumentParserError("archive_too_large", message);
};

const findEocdOffset = (buffer) => {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH_BYTES);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
};

export const enforceOfficeZipLimits = (buffer, limits = DEFAULT_OFFICE_ARCHIVE_LIMITS) => {
  const eocdOffset = findEocdOffset(buffer);
  if (eocdOffset === -1) {
    throw new DocumentParserError("invalid_archive", "Office document archive is invalid.");
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (entryCount === ZIP64_SIZE || centralDirectorySize === ZIP64_SIZE || centralDirectoryOffset === ZIP64_SIZE) {
    fail("Office document archive uses ZIP64 metadata, which is not accepted for uploads.");
  }

  if (entryCount > limits.maxEntries) {
    fail(`Office document archive has too many entries. Maximum is ${limits.maxEntries}.`);
  }

  if (
    centralDirectoryOffset > buffer.length
    || centralDirectorySize > buffer.length - centralDirectoryOffset
    || centralDirectoryOffset + centralDirectorySize > eocdOffset
  ) {
    throw new DocumentParserError("invalid_archive", "Office document archive directory is invalid.");
  }

  let offset = centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new DocumentParserError("invalid_archive", "Office document archive directory is invalid.");
    }

    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);

    if (compressedSize === ZIP64_SIZE || uncompressedSize === ZIP64_SIZE) {
      fail("Office document archive uses ZIP64 entries, which are not accepted for uploads.");
    }

    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      fail(`Office document archive contains an entry larger than ${limits.maxEntryUncompressedBytes} bytes.`);
    }

    if (compressedSize > 0 && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
      fail(`Office document archive contains an entry with a compression ratio above ${limits.maxCompressionRatio}.`);
    }

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > limits.maxTotalUncompressedBytes) {
      fail(`Office document archive expands beyond ${limits.maxTotalUncompressedBytes} bytes.`);
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  if (offset !== centralDirectoryOffset + centralDirectorySize) {
    throw new DocumentParserError("invalid_archive", "Office document archive directory is invalid.");
  }
};
