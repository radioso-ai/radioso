import sanitizeHtml from "sanitize-html";

import { readInboundMimeContent, type InboundEmailMessage } from "../../mail/public.js";

/**
 * The operator's view of a stored raw message (research A11, B10): display-safe headers, the
 * plain text, and HTML sanitized server-side for a sandboxed frame. Relay tokens and thread tokens
 * never reach the view.
 */
export interface RawMessageView {
  headers: readonly { name: string; value: string }[];
  text: string | null;
  sanitizedHtml: string | null;
  truncated: boolean;
  attachments: InboundEmailMessage["attachments"];
}

export interface RawMessageRedaction {
  /** Inbound relay domains: the local part of every address on them is a relay token. */
  relayDomains: readonly string[];
  /** Mailbox addresses: a plus subaddress of one of them carries a thread token. */
  mailboxAddresses: readonly string[];
}

/** Headers an operator needs to read a message and its classification; routing hops stay out. */
const DISPLAY_HEADERS = new Set([
  "from",
  "sender",
  "reply-to",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "auto-submitted",
  "precedence",
  "list-id",
  "x-auto-response-suppress",
]);

/** No parentheses or escapes, so no url(), image-set() or expression(); colour functions aside. */
const SAFE_CSS_VALUES = [/^[^()\\]*$/, /^(?:rgba?|hsla?)\(\s*[\d.,%\s/]+\)$/i];

const SAFE_CSS_PROPERTIES = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "text-align",
  "text-decoration",
  "text-indent",
  "text-transform",
  "line-height",
  "letter-spacing",
  "white-space",
  "vertical-align",
  "direction",
  "display",
  "width",
  "height",
  "max-width",
  "min-width",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-collapse",
  "border-spacing",
  "border-radius",
  "list-style-type",
];

const keepUrlWithScheme =
  (attribute: string, scheme: RegExp): sanitizeHtml.Transformer =>
  (tagName, attribs) => {
    const { [attribute]: url, ...rest } = attribs;
    return { tagName, attribs: url !== undefined && scheme.test(url.trim()) ? { ...rest, [attribute]: url } : rest };
  };

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "font", "center"],
  allowedAttributes: {
    "*": ["style", "dir", "align", "title", "lang"],
    a: ["href", "name"],
    img: ["src", "alt", "width", "height"],
    table: ["width", "border", "cellpadding", "cellspacing"],
    td: ["colspan", "rowspan", "valign", "width"],
    th: ["colspan", "rowspan", "valign", "width"],
    font: ["color", "size", "face"],
  },
  allowedSchemes: ["mailto"],
  allowedSchemesByTag: { img: ["cid"] },
  allowProtocolRelative: false,
  allowedStyles: {
    "*": Object.fromEntries(SAFE_CSS_PROPERTIES.map((property) => [property, SAFE_CSS_VALUES])),
  },
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "title", "head", "template"],
  // Relative URLs would resolve against the embedding page, so only cid: and mailto: survive.
  transformTags: {
    a: keepUrlWithScheme("href", /^mailto:/i),
    img: keepUrlWithScheme("src", /^cid:/i),
  },
};

export const buildRawMessageView = async (
  stored: { raw: Buffer; truncated: boolean },
  redaction: RawMessageRedaction,
): Promise<RawMessageView> => {
  const content = await readInboundMimeContent(stored.raw);
  const isSecret = secretAddressMatcher(redaction);
  return {
    headers: content.headers.filter(
      (header) =>
        DISPLAY_HEADERS.has(header.name.toLowerCase()) && !addressesIn(header.value).some(isSecret),
    ),
    text: content.text,
    sanitizedHtml: content.html === null ? null : sanitizeHtml(content.html, SANITIZE_OPTIONS),
    truncated: stored.truncated,
    attachments: content.attachments,
  };
};

/** Address-shaped tokens (`local@domain`) anywhere in a header value; message ids included. */
const addressesIn = (value: string): string[] =>
  (value.match(/[^\s<>()[\]",;:]+@[^\s<>()[\]",;:]+/g) ?? []).map((address) =>
    address.toLowerCase().replace(/\.$/, ""),
  );

const secretAddressMatcher = (redaction: RawMessageRedaction) => {
  const relayDomains = new Set(redaction.relayDomains.map((domain) => domain.toLowerCase()));
  const mailboxes = new Set(redaction.mailboxAddresses.map((address) => address.toLowerCase()));
  return (address: string): boolean => {
    const at = address.lastIndexOf("@");
    const local = address.slice(0, at);
    const domain = address.slice(at + 1);
    const plus = local.indexOf("+");
    return (
      relayDomains.has(domain) || (plus > 0 && mailboxes.has(`${local.slice(0, plus)}@${domain}`))
    );
  };
};
