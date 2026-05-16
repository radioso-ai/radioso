import { parseDocx } from "./parsers/docx.js";
import { parsePdf } from "./parsers/pdf.js";
import { parseTxt } from "./parsers/txt.js";
import { parseXlsx } from "./parsers/xlsx.js";
import { DocumentParserError } from "./errors.js";

export const SUPPORTED_DOCUMENT_TYPES = ["pdf", "txt", "docx", "xlsx"];

const MIME_TYPE_MAP = new Map([
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
]);

const EXTENSION_TYPE_MAP = new Map([
  [".pdf", "pdf"],
  [".txt", "txt"],
  [".docx", "docx"],
  [".xlsx", "xlsx"],
]);

const PARSERS = {
  pdf: parsePdf,
  txt: parseTxt,
  docx: parseDocx,
  xlsx: parseXlsx,
};

export { DocumentParserError };

const normalizeLineEndings = (value) => value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

const normalizeText = (value) =>
  normalizeLineEndings(value)
    .replace(/\u0000/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const getExtension = (filename) => {
  const normalized = filename?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const dotIndex = normalized.lastIndexOf(".");
  return dotIndex === -1 ? null : normalized.slice(dotIndex);
};

export const detectDocumentType = ({ filename, mimeType } = {}) => {
  const normalizedMimeType = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedMimeType && MIME_TYPE_MAP.has(normalizedMimeType)) {
    return MIME_TYPE_MAP.get(normalizedMimeType);
  }

  const extension = getExtension(filename);
  if (extension && EXTENSION_TYPE_MAP.has(extension)) {
    return EXTENSION_TYPE_MAP.get(extension);
  }

  throw new DocumentParserError("unsupported_type", "Unsupported document type");
};

export const parseDocument = async ({ buffer, filename, mimeType }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new DocumentParserError("empty_file", "Uploaded file is empty");
  }

  const fileType = detectDocumentType({ filename, mimeType });
  const parser = PARSERS[fileType];
  const parsed = await parser({ buffer, filename, mimeType });
  const text = normalizeText(parsed.text ?? "");
  const markdown = normalizeText(parsed.markdown ?? parsed.text ?? "");

  if (!text) {
    throw new DocumentParserError("empty_content", "The uploaded file did not contain extractable text");
  }

  return {
    fileType,
    text,
    markdown: markdown || text,
    sourceHints: parsed.sourceHints ?? {},
  };
};
