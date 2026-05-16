import { loadDependency } from "./loadDependency.js";
import { DocumentParserError } from "../errors.js";
import { enforceOfficeZipLimits } from "./officeZipLimits.js";

const mammoth = loadDependency("mammoth");
const MAX_DOCX_EXTRACTED_TEXT_CHARS = 5_000_000;

export const parseDocx = async ({ buffer }) => {
  enforceOfficeZipLimits(buffer);

  const result = await mammoth.extractRawText({ buffer });
  const value = result.value ?? "";
  if (value.length > MAX_DOCX_EXTRACTED_TEXT_CHARS) {
    throw new DocumentParserError(
      "document_too_large",
      `DOCX text exceeds the ${MAX_DOCX_EXTRACTED_TEXT_CHARS} character extraction limit.`,
    );
  }

  return {
    text: value,
    markdown: value,
    sourceHints: {
      messages: result.messages ?? [],
    },
  };
};
