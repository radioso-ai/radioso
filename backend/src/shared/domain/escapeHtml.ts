/**
 * Escapes text for HTML element content and quoted attribute values, so a value written by a
 * visitor or an operator renders as the characters it contains and never as markup.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
