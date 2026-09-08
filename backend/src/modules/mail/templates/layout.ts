import { emailTheme as t } from "./theme.js";

/**
 * The Radioso email shell. Templates describe what a message says; this module decides how every
 * Radioso email looks, so a new message inherits the brand instead of restating it.
 *
 * Constraints this encodes, none of them obvious from the markup:
 * - Mail clients strip `<svg>`, so the wordmark is live text over the brand accent bar. An image
 *   blocked by the client still leaves a branded header.
 * - Layout is table-based with inline styles because Outlook renders through Word, which ignores
 *   most block-level CSS. The `<style>` block is progressive enhancement only.
 * - Every value reaching the markup is escaped here. Templates pass plain strings.
 */

export interface EmailCta {
  href: string;
  label: string;
}

export interface EmailMetaRow {
  label: string;
  value: string;
}

export interface EmailContent {
  /** The inbox preview line. Clients show it beside the subject, so it must not repeat it. */
  preheader: string;
  heading: string;
  paragraphs: string[];
  cta?: EmailCta;
  /** Short labelled facts — an expiry date, a workspace name — shown under the call to action. */
  metaRows?: EmailMetaRow[];
  /** The reassuring closing line, set quieter than the body. */
  footnote?: string;
}

const MARKETING_URL = "https://radioso.ai";

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const paragraph = (text: string): string =>
  `<p style="margin:0 0 16px 0;font-family:${t.font.body};font-size:15px;line-height:24px;color:${t.color.ink};" class="r-text">${escapeHtml(text)}</p>`;

/**
 * A table-cell button: Outlook ignores padding on an inline anchor but honours cell padding and
 * `bgcolor`, so this fills correctly everywhere. Outlook desktop squares off the corners.
 */
const callToAction = (cta: EmailCta): string => `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">
          <tr>
            <td bgcolor="${t.color.brand}" style="border-radius:6px;" align="center">
              <a href="${escapeHtml(cta.href)}" style="display:inline-block;padding:12px 24px;font-family:${t.font.body};font-size:14px;font-weight:500;line-height:20px;color:${t.color.onBrand};text-decoration:none;border-radius:6px;">${escapeHtml(cta.label)}</a>
            </td>
          </tr>
        </table>`;

const metaRow = (row: EmailMetaRow): string => `
          <tr>
            <td style="padding:0 16px 8px 0;font-family:${t.font.body};font-size:13px;line-height:20px;color:${t.color.mutedInk};white-space:nowrap;" class="r-muted">${escapeHtml(row.label)}</td>
            <td style="padding:0 0 8px 0;font-family:${t.font.body};font-size:13px;line-height:20px;color:${t.color.ink};" class="r-text">${escapeHtml(row.value)}</td>
          </tr>`;

const metaTable = (rows: EmailMetaRow[]): string => `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;">${rows.map(metaRow).join("")}
        </table>`;

/** The brand device from the docs OG card: a wide brand bar followed by a short accent bar. */
const accentBar = (): string => `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px 0;">
          <tr>
            <td width="160" height="10" bgcolor="${t.color.brand}" style="width:160px;height:10px;line-height:10px;font-size:0;">&nbsp;</td>
            <td width="48" height="10" bgcolor="${t.color.accent}" style="width:48px;height:10px;line-height:10px;font-size:0;">&nbsp;</td>
          </tr>
        </table>`;

export const renderEmail = (content: EmailContent): string => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${escapeHtml(content.heading)}</title>
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  @media (prefers-color-scheme: dark) {
    .r-canvas { background:${t.color.darkCanvas} !important; }
    .r-card { background:${t.color.darkCard} !important; border-color:${t.color.darkBorder} !important; }
    .r-text, .r-wordmark { color:${t.color.darkInk} !important; }
    .r-muted { color:${t.color.darkMutedInk} !important; }
  }
  @media only screen and (max-width:620px) {
    .r-card { padding:24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:${t.color.canvas};" class="r-canvas">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(content.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${t.color.canvas};" class="r-canvas">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${t.contentWidthPx}" style="width:${t.contentWidthPx}px;max-width:100%;">
        <tr>
          <td style="padding:0 0 20px 0;">${accentBar()}
            <div style="font-family:${t.font.display};font-size:20px;line-height:24px;font-weight:700;letter-spacing:-0.01em;color:${t.color.ink};" class="r-wordmark">Radioso</div>
          </td>
        </tr>
        <tr>
          <td bgcolor="${t.color.card}" style="background:${t.color.card};border:1px solid ${t.color.border};border-radius:8px;padding:32px;" class="r-card">
            <h1 style="margin:0 0 16px 0;font-family:${t.font.display};font-size:24px;line-height:32px;font-weight:600;color:${t.color.ink};" class="r-text">${escapeHtml(content.heading)}</h1>
${content.paragraphs.map((text) => `            ${paragraph(text)}`).join("\n")}
${content.cta ? callToAction(content.cta) : ""}
${content.metaRows?.length ? metaTable(content.metaRows) : ""}
${content.footnote ? `            <p style="margin:0;font-family:${t.font.body};font-size:13px;line-height:20px;color:${t.color.mutedInk};" class="r-muted">${escapeHtml(content.footnote)}</p>` : ""}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 0 0 0;font-family:${t.font.body};font-size:12px;line-height:18px;color:${t.color.mutedInk};" class="r-muted">
            <a href="${MARKETING_URL}" style="color:${t.color.mutedInk};text-decoration:none;" class="r-muted">Radioso</a> &mdash; agents that answer, act, and hand off.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

/** The plaintext mirror. Every message sends both; some clients and most filters read only this. */
export const renderEmailText = (content: EmailContent): string => {
  const blocks: string[] = [content.heading, ...content.paragraphs];
  if (content.cta) {
    blocks.push(`${content.cta.label}: ${content.cta.href}`);
  }
  if (content.metaRows?.length) {
    blocks.push(content.metaRows.map((row) => `${row.label}: ${row.value}`).join("\n"));
  }
  if (content.footnote) {
    blocks.push(content.footnote);
  }
  blocks.push(`Radioso — agents that answer, act, and hand off.\n${MARKETING_URL}`);
  return blocks.join("\n\n");
};
