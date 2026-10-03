import { convert, type HtmlToTextOptions } from "html-to-text";

import type { InboundEmailMessage } from "../../mail/public.js";

import { removeQuoteContainers, stripQuotedHistory, type StripConfidence } from "./quotedHistory.js";

/**
 * The customer message an email becomes (FR-013): the plain-text body, or the HTML body converted
 * to text, with quoted history and signature stripped only when the stripper is confident.
 */
interface CustomerText {
  subject: string | null;
  text: string;
  confidence: StripConfidence;
}

const HTML_TO_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  selectors: [
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    { selector: "img", format: "skip" },
    { selector: "hr", format: "skip" },
    ...(["h1", "h2", "h3", "h4", "h5", "h6"] as const).map((selector) => ({
      selector,
      options: { uppercase: false },
    })),
  ],
};

export const extractCustomerText = (
  message: Pick<InboundEmailMessage, "subject" | "text" | "html">,
  priorOutboundTexts: readonly string[],
): CustomerText => {
  const subject = normalizeSubject(message.subject);
  if (hasVisibleText(message.text)) {
    return { subject, ...confidenceOnly(stripQuotedHistory({ text: message.text, priorOutboundTexts })) };
  }
  if (message.html) {
    const withoutContainers = removeQuoteContainers(message.html);
    const stripped = stripQuotedHistory({
      text: htmlToText(withoutContainers.html),
      fullText: htmlToText(message.html),
      signals: withoutContainers.signals,
      priorOutboundTexts,
    });
    return { subject, ...confidenceOnly(stripped) };
  }
  return { subject, text: "", confidence: "full_text" };
};

const hasVisibleText = (text: string | null): text is string =>
  text !== null && text.trim().length > 0;

const htmlToText = (html: string): string => convert(html, HTML_TO_TEXT_OPTIONS);

const confidenceOnly = (result: { text: string; confidence: StripConfidence }) => ({
  text: result.text,
  confidence: result.confidence,
});

/** Header folding and stray control whitespace become single spaces; a blank subject is none. */
const normalizeSubject = (subject: string | null): string | null => {
  const normalized = subject?.replace(/\s+/g, " ").trim() ?? "";
  return normalized.length > 0 ? normalized : null;
};
