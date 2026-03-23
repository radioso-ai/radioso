const UTF8_BOM = "\uFEFF";

export const parseTxt = async ({ buffer }) => {
  let text = buffer.toString("utf8");
  if (text.startsWith(UTF8_BOM)) {
    text = text.slice(1);
  }

  return {
    text,
    markdown: text,
    sourceHints: {},
  };
};
