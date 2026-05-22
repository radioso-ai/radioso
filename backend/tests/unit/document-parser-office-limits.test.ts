import { parseDocument } from "@radioso/document-parser";
import { describe, expect, it } from "vitest";

const buildZipWithCentralDirectoryEntry = (input: {
  compressedSize: number;
  fileName: string;
  uncompressedSize: number;
}) => {
  const fileName = Buffer.from(input.fileName);
  const localHeader = Buffer.alloc(30 + fileName.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt32LE(input.compressedSize, 18);
  localHeader.writeUInt32LE(input.uncompressedSize, 22);
  localHeader.writeUInt16LE(fileName.length, 26);
  fileName.copy(localHeader, 30);

  const centralDirectory = Buffer.alloc(46 + fileName.length);
  centralDirectory.writeUInt32LE(0x02014b50, 0);
  centralDirectory.writeUInt32LE(input.compressedSize, 20);
  centralDirectory.writeUInt32LE(input.uncompressedSize, 24);
  centralDirectory.writeUInt16LE(fileName.length, 28);
  fileName.copy(centralDirectory, 46);

  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(1, 8);
  endOfCentralDirectory.writeUInt16LE(1, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(localHeader.length, 16);

  return Buffer.concat([localHeader, centralDirectory, endOfCentralDirectory]);
};

describe("office document parser resource limits", () => {
  it("rejects DOCX archives that would expand beyond the parser limit", async () => {
    const buffer = buildZipWithCentralDirectoryEntry({
      compressedSize: 1024,
      fileName: "word/document.xml",
      uncompressedSize: 26 * 1024 * 1024,
    });

    await expect(parseDocument({
      buffer,
      filename: "oversized.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })).rejects.toMatchObject({
      code: "archive_too_large",
      name: "DocumentParserError",
    });
  });

  it("rejects XLSX archives with suspicious compression ratios before ExcelJS loads them", async () => {
    const buffer = buildZipWithCentralDirectoryEntry({
      compressedSize: 1,
      fileName: "xl/worksheets/sheet1.xml",
      uncompressedSize: 1024 * 1024,
    });

    await expect(parseDocument({
      buffer,
      filename: "compressed.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })).rejects.toMatchObject({
      code: "archive_too_large",
      name: "DocumentParserError",
    });
  });
});
