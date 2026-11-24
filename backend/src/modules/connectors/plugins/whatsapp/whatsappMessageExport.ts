import { exportTimestamp, type DataSubjectExportRecord } from "../../../../shared/domain/dataSubjectAccess.js";

/** One row of the WhatsApp transport's message log, as a data subject's export reads it. */
export interface WhatsAppLoggedMessage {
  readonly wamid: string;
  readonly waId: string;
  readonly direction: string;
  readonly messageType: string;
  readonly status: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
const arrayOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const textOf = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** The media kinds whose object Meta reports by id, with the caption and file name a sender gave it. */
const MEDIA_TYPES = new Set(["image", "video", "audio", "document", "sticker"]);

/**
 * The message a webhook delivery carries under `wamid`, sent by `waId`. A delivery can batch several
 * senders' messages, so the rest of the body is never read.
 */
const deliveredMessage = (payload: unknown, wamid: string, waId: string): JsonObject | undefined => {
  if (!isObject(payload)) return undefined;
  for (const entry of arrayOf(payload.entry)) {
    for (const change of isObject(entry) ? arrayOf(entry.changes) : []) {
      const value = isObject(change) ? change.value : undefined;
      for (const message of isObject(value) ? arrayOf(value.messages) : []) {
        if (isObject(message) && message.id === wamid && message.from === waId) return message;
      }
    }
  }
  return undefined;
};

/** What the sender wrote or picked, and the media object they sent, by Meta's message format. */
const inboundContent = (message: JsonObject): DataSubjectExportRecord => {
  const type = textOf(message.type);
  if (type === "text") {
    const text = isObject(message.text) ? textOf(message.text.body) : undefined;
    return text ? { text } : {};
  }
  if (type && MEDIA_TYPES.has(type) && isObject(message[type])) {
    const media = message[type] as JsonObject;
    const id = textOf(media.id);
    const filename = textOf(media.filename);
    const caption = textOf(media.caption);
    return {
      ...(caption ? { text: caption } : {}),
      ...(id ? { media: { id, ...(filename ? { filename } : {}) } } : {}),
    };
  }
  if (type === "interactive" && isObject(message.interactive)) {
    const reply = message.interactive.button_reply ?? message.interactive.list_reply;
    const title = isObject(reply) ? textOf(reply.title) : undefined;
    return title ? { text: title } : {};
  }
  if (type === "button" && isObject(message.button)) {
    const text = textOf(message.button.text);
    return text ? { text } : {};
  }
  return {};
};

/** A reply's text as Radioso sent it; the channel's own state on the row stays out. */
const outboundContent = (payload: unknown): DataSubjectExportRecord => {
  const text = isObject(payload) ? textOf(payload.text) : undefined;
  return text ? { text } : {};
};

const contentOf = (row: WhatsAppLoggedMessage): DataSubjectExportRecord => {
  if (row.direction !== "inbound") return outboundContent(row.payload);
  const message = deliveredMessage(row.payload, row.wamid, row.waId);
  return message ? inboundContent(message) : {};
};

/**
 * One message of a data subject's, as their export carries it: its direction, type, delivery status
 * and time, with the text and the media reference of that message alone. The raw webhook body stays
 * out, as an email's raw MIME does: it can hold other senders' messages, and the channel's own state.
 */
export const exportedWhatsAppMessage = (row: WhatsAppLoggedMessage): DataSubjectExportRecord => ({
  number: `+${row.waId}`,
  direction: row.direction,
  type: row.messageType,
  status: row.status,
  createdAt: exportTimestamp(row.createdAt),
  ...contentOf(row),
});
