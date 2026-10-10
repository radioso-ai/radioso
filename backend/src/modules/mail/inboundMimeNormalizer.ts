import PostalMime, { addressParser, decodeWords } from "postal-mime";
import type { Address, Attachment, Email, Header } from "postal-mime";

import { InboundFetchError, type InboundEmailMessage } from "./inboundEmailReceiver.js";

/**
 * Provider-neutral MIME normalization shared by every inbound receiver. Every field is read from
 * the raw message itself, so each provider yields the same `InboundEmailMessage`. What only the
 * provider knows (the SMTP `for` recipients, authentication results, a spam verdict) arrives as
 * facts from the adapter.
 */
export interface InboundProviderFacts {
  receivedFor: readonly string[];
  authentication: InboundEmailMessage["authentication"];
  spamVerdict: InboundEmailMessage["spamVerdict"];
}

/** One header as a person reads it: original name, unfolded, encoded words decoded. */
interface InboundMimeHeader {
  name: string;
  value: string;
}

interface InboundMimeContent {
  headers: readonly InboundMimeHeader[];
  text: string | null;
  html: string | null;
  attachments: InboundEmailMessage["attachments"];
}

const ORIGINAL_HEADER_PART_TYPES = new Set([
  "message/rfc822",
  "message/global",
  "text/rfc822-headers",
  "message/global-headers",
]);

export const normalizeInboundMime = async (
  raw: Buffer,
  facts: InboundProviderFacts,
): Promise<InboundEmailMessage> => {
  const email = await parseMime(raw);
  return {
    rfcMessageId: firstMessageId(headerValue(email.headers, "message-id")),
    inReplyTo: firstMessageId(headerValue(email.headers, "in-reply-to")),
    references: messageIds(headerValue(email.headers, "references")),
    from: senderOf(email.from),
    to: addressesOf(email.to),
    cc: addressesOf(email.cc),
    deliveredTo: deliveredToSet(email.headers, facts.receivedFor),
    subject: email.subject ?? null,
    text: email.text ?? null,
    html: email.html ?? null,
    automation: {
      autoSubmitted: headerValue(email.headers, "auto-submitted"),
      precedence: headerValue(email.headers, "precedence"),
      autoResponseSuppress: headerValue(email.headers, "x-auto-response-suppress"),
      listId: headerValue(email.headers, "list-id"),
    },
    report: await deliveryReportOf(email),
    attachments: attachmentManifest(email.attachments),
    authentication: facts.authentication,
    spamVerdict: facts.spamVerdict,
    raw,
  };
};

/** The displayable parts of a stored raw message, for the operator's raw view. */
export const readInboundMimeContent = async (raw: Buffer): Promise<InboundMimeContent> => {
  const email = await parseMime(raw);
  return {
    headers: email.headers.map((header) => ({
      name: header.originalKey,
      value: decodeWords(header.value).trim(),
    })),
    text: email.text ?? null,
    html: email.html ?? null,
    attachments: attachmentManifest(email.attachments),
  };
};

const parseMime = async (raw: Buffer | Uint8Array | ArrayBuffer): Promise<Email> => {
  try {
    return await PostalMime.parse(raw);
  } catch {
    throw new InboundFetchError(false, "unparseable_mime");
  }
};

const headerValue = (headers: readonly Header[], key: string): string | null => {
  const value = headers.find((header) => header.key === key)?.value.trim();
  return value ? value : null;
};

const headerValues = (headers: readonly Header[], key: string): string[] =>
  headers.filter((header) => header.key === key).map((header) => header.value);

/** RFC 5322 msg-id tokens, angle brackets kept; a bare value stands in when none is bracketed. */
const messageIds = (value: string | null): string[] => {
  if (!value) {
    return [];
  }
  const bracketed = value.match(/<[^<>\s]+>/g);
  const ids = bracketed ?? value.split(/[\s,]+/).filter((token) => token.length > 0);
  return [...new Set(ids)];
};

const firstMessageId = (value: string | null): string | null => messageIds(value)[0] ?? null;

const flatMailboxes = (addresses: readonly Address[] | undefined) =>
  (addresses ?? []).flatMap((address) => (address.group ? address.group : [address]));

const addressesOf = (addresses: readonly Address[] | undefined): string[] =>
  flatMailboxes(addresses)
    .map((mailbox) => mailbox.address.trim())
    .filter((address) => address.length > 0);

const senderOf = (from: Address | undefined): InboundEmailMessage["from"] => {
  const mailbox = flatMailboxes(from ? [from] : []).find((candidate) => candidate.address.trim());
  if (!mailbox) {
    return null;
  }
  const displayName = mailbox.name.trim();
  return { address: mailbox.address.trim(), displayName: displayName || null };
};

/** received_for ∪ Delivered-To ∪ X-Original-To, deduplicated case-insensitively, first spelling kept. */
const deliveredToSet = (headers: readonly Header[], receivedFor: readonly string[]): string[] => {
  const fromHeaders = [
    ...headerValues(headers, "delivered-to"),
    ...headerValues(headers, "x-original-to"),
  ].flatMap((value) => addressesOf(addressParser(value, { flatten: true })));
  const seen = new Set<string>();
  const union: string[] = [];
  for (const address of [...receivedFor.map((value) => value.trim()), ...fromHeaders]) {
    const key = address.toLowerCase();
    if (address.length > 0 && !seen.has(key)) {
      seen.add(key);
      union.push(address);
    }
  }
  return union;
};

/** Media type and parameters of a Content-Type value, compared as case-insensitive protocol tokens. */
const contentTypeOf = (value: string | null): { mediaType: string; params: Map<string, string> } => {
  const [mediaType = "", ...rawParams] = (value ?? "").split(";");
  const params = new Map<string, string>();
  for (const param of rawParams) {
    const separator = param.indexOf("=");
    if (separator > 0) {
      const name = param.slice(0, separator).trim().toLowerCase();
      const paramValue = param.slice(separator + 1).trim().replace(/^"(.*)"$/, "$1");
      params.set(name, paramValue.toLowerCase());
    }
  }
  return { mediaType: mediaType.trim().toLowerCase(), params };
};

const isDeliveryStatusReport = (headers: readonly Header[]): boolean => {
  const contentType = contentTypeOf(headerValue(headers, "content-type"));
  return (
    contentType.mediaType === "multipart/report" &&
    contentType.params.get("report-type") === "delivery-status"
  );
};

/** RFC 3464: the returned original (or its headers) names the Message-ID that bounced. */
const deliveryReportOf = async (email: Email): Promise<InboundEmailMessage["report"]> => {
  if (!isDeliveryStatusReport(email.headers)) {
    return null;
  }
  const originalParts = email.attachments.filter((attachment) =>
    ORIGINAL_HEADER_PART_TYPES.has(attachment.mimeType),
  );
  const ids: string[] = [];
  for (const part of originalParts) {
    const original = await PostalMime.parse(attachmentBytes(part)).catch(() => null);
    const id = original ? firstMessageId(headerValue(original.headers, "message-id")) : null;
    if (id && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return { kind: "delivery_status", originalMessageIds: ids };
};

const attachmentBytes = (attachment: Attachment): Uint8Array =>
  typeof attachment.content === "string"
    ? Buffer.from(attachment.content, attachment.encoding === "base64" ? "base64" : "utf8")
    : attachment.content instanceof ArrayBuffer
      ? new Uint8Array(attachment.content)
      : attachment.content;

const attachmentManifest = (
  attachments: readonly Attachment[],
): InboundEmailMessage["attachments"] =>
  attachments.map((attachment) => ({
    name: attachment.filename ?? "",
    contentType: attachment.mimeType,
    sizeBytes: attachmentBytes(attachment).byteLength,
  }));
