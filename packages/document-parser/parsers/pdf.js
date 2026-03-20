import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const pdfParse = require("pdf-parse");

export const parsePdf = async ({ buffer }) => {
  const result = await pdfParse(buffer);

  return {
    text: result.text ?? "",
    markdown: result.text ?? "",
    sourceHints: {
      pageCount: result.numpages ?? null,
      info: result.info ?? null,
    },
  };
};
