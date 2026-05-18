export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

export const button = (input: { href: string; label: string }): string => {
  const href = escapeHtml(input.href);
  const label = escapeHtml(input.label);
  return `<p style="margin:0 0 16px 0;"><a href="${href}" style="display:inline-block;padding:8px 14px;background:#111827;color:#ffffff;border-radius:6px;text-decoration:none;">${label}</a></p>`;
};
