import { z } from "zod";

export const CONTACT_NAME_MAX_LENGTH = 200;
export const CONTACT_MESSAGE_MAX_LENGTH = 4_000;
export const NOTICE_SLOT_VALUE_MAX_LENGTH = 1_000;
export const REPLY_TO_MAX_LENGTH = 320;

const replyToSchema = z.string().trim().max(REPLY_TO_MAX_LENGTH).email();

export const boundedVisitorText = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, maxLength) : null;
};

export const validVisitorReplyTo = (value: unknown): string | null => {
  const parsed = replyToSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
