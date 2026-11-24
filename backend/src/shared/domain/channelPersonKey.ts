import { badRequest } from "./errors.js";

/**
 * A person key a channel attests (#1884): who a conversation is with, as the channel that carries it
 * knows them, where the channel's provider vouches for it. WhatsApp's is the sender's number, which
 * Meta reports as `wa_id` on a signed webhook. Person-level values are kept under it and read only on
 * its own channel: nothing links it to a verified customer id or to another channel's key.
 *
 * The id is a phone number. It is never logged, never a metric label or span attribute, and never
 * sent in an event or a webhook.
 */
export const CHANNEL_PERSON_KEY_KINDS = ["whatsapp_contact"] as const;

export type ChannelPersonKeyKind = typeof CHANNEL_PERSON_KEY_KINDS[number];

export interface ChannelPersonKey {
  readonly kind: ChannelPersonKeyKind;
  /** The key as the channel stores it: for WhatsApp, the number's digits (`whatsAppNumberKey`). */
  readonly id: string;
}

export const isChannelPersonKeyKind = (value: string): value is ChannelPersonKeyKind =>
  (CHANNEL_PERSON_KEY_KINDS as readonly string[]).includes(value);

/** What a person may type into a number besides its digits: spaces, dashes, dots and brackets. */
const NUMBER_FORMATTING = /[\s\-.()]/gu;
/** A number in international form as E.164 writes it: a country code, which never starts with 0, and at most 15 digits in all. */
const INTERNATIONAL_NUMBER = /^[1-9]\d{5,14}$/u;
/** Digits, with or without a leading `+`, once the formatting is gone. */
const WRITTEN_AS_NUMBER = /^\+?\d+$/u;

const NUMBER_REFUSALS = {
  prefixed: "A WhatsApp number starts with its country code: write it as +<country code><number>, without a leading 0 or 00.",
  malformed: "A WhatsApp number is its country code and number, 6 to 15 digits in all: write it as +<country code><number>.",
} as const;

/**
 * A typed WhatsApp number as `wa_id` stores it: its digits, country code first, with no `+`. Or why it
 * is not one, said so a person can write it again: a number written with a trunk or international
 * call prefix (`0…`, `00…`) instead of its country code is not the number `wa_id` holds.
 * `writtenAsNumber` says the input was a phone number in form, a `+` or a leading `0` and digits.
 */
export const readWhatsAppNumber = (raw: string): { digits: string } | { refusal: string; writtenAsNumber: boolean } => {
  const written = raw.trim().replace(NUMBER_FORMATTING, "");
  const digits = written.replace(/^\+/u, "");
  if (INTERNATIONAL_NUMBER.test(digits)) return { digits };
  const prefixed = WRITTEN_AS_NUMBER.test(written) && digits.startsWith("0");
  return {
    refusal: prefixed ? NUMBER_REFUSALS.prefixed : NUMBER_REFUSALS.malformed,
    writtenAsNumber: WRITTEN_AS_NUMBER.test(written) && (written.startsWith("+") || prefixed),
  };
};

/** A WhatsApp number as `wa_id` stores it (`readWhatsAppNumber`); null for anything that is not one. */
export const whatsAppNumberKey = (raw: string): string | null => {
  const read = readWhatsAppNumber(raw);
  return "digits" in read ? read.digits : null;
};

/** A channel person key's id in the form its channel stores it; null when `raw` is not one. */
export const channelPersonKeyId = (kind: ChannelPersonKeyKind, raw: string): string | null => {
  switch (kind) {
    case "whatsapp_contact":
      return whatsAppNumberKey(raw);
  }
};

/**
 * A channel person key's id in the form its channel stores it, for a value a caller keeps or reads
 * under one: the one place a key a person typed is read. Refuses one that is not a key of its kind
 * (400), saying how to write it.
 */
export const requireChannelPersonKeyId = (kind: ChannelPersonKeyKind, raw: string): string => {
  switch (kind) {
    case "whatsapp_contact": {
      const read = readWhatsAppNumber(raw);
      if ("digits" in read) return read.digits;
      throw badRequest(read.refusal);
    }
  }
};

/**
 * Which channel person a stored conversation is with, as the channel that keeps the key knows it;
 * null for a conversation of another channel or one it has no key for. A reader outside a turn (the
 * Inbox, the classifier, a decision's resume) asks this; a turn carries the key its channel attested.
 */
export interface ConversationChannelPersonKeys {
  personKeyOf(input: { workspaceId: string; conversationId: string }): Promise<ChannelPersonKey | null>;
}
