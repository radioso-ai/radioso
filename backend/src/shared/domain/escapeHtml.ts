/**
 * Escapes the five characters that let text open or close a tag or an attribute value, so
 * text placed into HTML renders as the characters it contains rather than as markup.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
