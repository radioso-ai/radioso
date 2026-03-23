import { loadDependency } from "./loadDependency.js";

const mammoth = loadDependency("mammoth");

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
