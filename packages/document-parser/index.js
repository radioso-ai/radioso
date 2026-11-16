import { parseDocx } from "./parsers/docx.js";
import { parseMarkdown } from "./parsers/markdown.js";
import { parsePdf } from "./parsers/pdf.js";
import { parseTxt } from "./parsers/txt.js";
import { parseXlsx } from "./parsers/xlsx.js";
import { DocumentParserError } from "./errors.js";
import { normalizeText, normalizeTextWithOffsets } from "./normalizeText.js";
import { extractDocxImages } from "./parsers/docxImages.js";
import { extractMarkdownImages } from "./parsers/markdownImages.js";
import { extractPdfImages } from "./parsers/pdfImages.js";

export const SUPPORTED_DOCUMENT_TYPES = ["pdf", "txt", "md", "docx", "xlsx"];

const MIME_TYPE_MAP = new Map([
  ["application/pdf", "pdf"],
  ["text/plain", "txt"],
  ["text/markdown", "md"],
  ["text/x-markdown", "md"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
]);

const EXTENSION_TYPE_MAP = new Map([
  [".pdf", "pdf"],
  [".txt", "txt"],
  [".md", "md"],
  [".markdown", "md"],
  [".docx", "docx"],
  [".xlsx", "xlsx"],
]);

const PARSERS = {
  pdf: parsePdf,
  txt: parseTxt,
  md: parseMarkdown,
  docx: parseDocx,
  xlsx: parseXlsx,
};

export { DocumentParserError };

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

/** Readers of the pictures a file carries, by type; a type without one carries none. */
const IMAGE_READERS = {
  pdf: extractPdfImages,
  md: extractMarkdownImages,
  docx: extractDocxImages,
};

const DEFAULT_IMAGE_EXTRACTION_LIMITS = {
  maxImages: 24,
  minShortSidePx: 0,
  maxImagesExamined: 48,
  maxTotalBytes: 96 * 1024 * 1024,
  timeBudgetMs: 45_000,
};

/**
 * The pictures a file carries, in document order: the images a DOCX or a PDF embeds, with their
 * bytes, and the images a markdown file links, with their address. Each is placed by an offset
 * into `text`, the same text `parseDocument` returns for the file (or, when a limit stopped the
 * reading early, the start of it).
 */
export const extractDocumentImages = async ({ buffer, filename, mimeType, limits = {} }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new DocumentParserError("empty_file", "Uploaded file is empty");
  }

  const fileType = detectDocumentType({ filename, mimeType });
  const reader = IMAGE_READERS[fileType];
  if (!reader) {
    return { fileType, text: "", images: [], truncated: false };
  }
  const read = await reader({ buffer, limits: { ...DEFAULT_IMAGE_EXTRACTION_LIMITS, ...limits } });
  const normalized = normalizeTextWithOffsets(read.text, read.images.map((image) => image.offset));
  return {
    fileType,
    text: normalized.text,
    images: read.images.map(({ offset: _offset, ...image }, index) => ({ ...image, textOffset: normalized.offsets[index] ?? 0 })),
    truncated: read.truncated,
  };
};
