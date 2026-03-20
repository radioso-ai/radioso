import { createRequire } from "node:module";

const require = createRequire(`${process.cwd()}/package.json`);
const mammoth = require("mammoth");

export const parseDocx = async ({ buffer }) => {
  const result = await mammoth.extractRawText({ buffer });

  return {
    text: result.value ?? "",
    markdown: result.value ?? "",
    sourceHints: {
      messages: result.messages ?? [],
    },
  };
};
