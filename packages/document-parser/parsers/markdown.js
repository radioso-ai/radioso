const UTF8_BOM = "﻿";

// Markdown is already in the canonical content format used downstream, so we
// preserve it verbatim (BOM aside) for both the plain-text and markdown views.
export const parseMarkdown = async ({ buffer }) => {
  let content = buffer.toString("utf8");
  if (content.startsWith(UTF8_BOM)) {
    content = content.slice(1);
  }

  return {
    text: content,
    markdown: content,
    sourceHints: {},
  };
};
