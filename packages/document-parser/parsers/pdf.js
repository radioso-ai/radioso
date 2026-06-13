import { loadDependency } from "./loadDependency.js";
import { DocumentParserError } from "../errors.js";

const pdfParse = loadDependency("pdf-parse");
const MAX_PDF_EXTRACTED_TEXT_CHARS = 5_000_000;

export const parsePdf = async ({ buffer }) => {
  const result = await pdfParse(buffer);
  const text = result.text ?? "";
  if (text.length > MAX_PDF_EXTRACTED_TEXT_CHARS) {
    throw new DocumentParserError(
      "document_too_large",
      `PDF text exceeds the ${MAX_PDF_EXTRACTED_TEXT_CHARS} character extraction limit.`,
    );
  }

  return {
    text,
    markdown: text,
    sourceHints: {
      pageCount: result.numpages ?? null,
      info: result.info ?? null,
    },
  };
};
