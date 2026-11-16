const UTF8_BOM = "﻿";

/** A markdown file's text as every reader of it sees it: UTF-8, without a leading byte-order mark. */
export const readMarkdownContent = (buffer) => {
  const content = buffer.toString("utf8");
  return content.startsWith(UTF8_BOM) ? content.slice(1) : content;
};

// Markdown is already in the canonical content format used downstream, so we
// preserve it verbatim (BOM aside) for both the plain-text and markdown views.
export const parseMarkdown = async ({ buffer }) => {
  const content = readMarkdownContent(buffer);

  return {
    text: content,
    markdown: content,
    sourceHints: {},
  };
};
