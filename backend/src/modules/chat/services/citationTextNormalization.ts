export const removeDetachedPunctuationSpacing = (text: string): string =>
  text
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+(\r?\n)/g, "$1");
