import { badRequest } from "../../shared/domain/errors.js";

import type { InternalUsageCursor, MessageUsageCursor } from "./contracts/index.js";

type CursorPayload = {
  occurredAt: string;
  id: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_MICROSECOND_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

const encode = (payload: CursorPayload): string => Buffer.from(JSON.stringify(payload)).toString("base64url");

const isUtcMicrosecondTimestamp = (value: string): boolean => {
  const match = UTC_MICROSECOND_TIMESTAMP.exec(value);
  if (!match) return false;

  const occurredAt = new Date(value);
  return Number.isFinite(occurredAt.getTime())
    && occurredAt.getUTCFullYear() === Number(match[1])
    && occurredAt.getUTCMonth() + 1 === Number(match[2])
    && occurredAt.getUTCDate() === Number(match[3])
    && occurredAt.getUTCHours() === Number(match[4])
    && occurredAt.getUTCMinutes() === Number(match[5])
    && occurredAt.getUTCSeconds() === Number(match[6]);
};

const decode = (value: string | undefined): CursorPayload | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      !parsed
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || typeof (parsed as Record<string, unknown>).occurredAt !== "string"
      || typeof (parsed as Record<string, unknown>).id !== "string"
    ) {
      throw new Error("invalid cursor shape");
    }
    const occurredAt = (parsed as Record<string, string>).occurredAt;
    const id = (parsed as Record<string, string>).id;
    if (!isUtcMicrosecondTimestamp(occurredAt) || !UUID.test(id)) {
      throw new Error("invalid cursor values");
    }
    return { occurredAt, id };
  } catch {
    throw badRequest("Invalid detailed usage cursor");
  }
};

export const encodeMessageUsageCursor = (cursor: MessageUsageCursor): string => encode({
  occurredAt: cursor.lastOccurredAt,
  id: cursor.messageId,
});

export const decodeMessageUsageCursor = (value: string | undefined): MessageUsageCursor | undefined => {
  const parsed = decode(value);
  return parsed ? { lastOccurredAt: parsed.occurredAt, messageId: parsed.id } : undefined;
};

export const encodeInternalUsageCursor = (cursor: InternalUsageCursor): string => encode({
  occurredAt: cursor.occurredAt,
  id: cursor.eventId,
});

export const decodeInternalUsageCursor = (value: string | undefined): InternalUsageCursor | undefined => {
  const parsed = decode(value);
  return parsed ? { occurredAt: parsed.occurredAt, eventId: parsed.id } : undefined;
};
