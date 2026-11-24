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
/** A number in international form, country code first. E.164 allows 15 digits; `wa_id` keeps up to 32 characters. */
const NUMBER_DIGITS = /^\d{6,20}$/u;

/**
 * A WhatsApp number the way `wa_id` stores it: its digits, country code first, with no `+`. Null for
 * anything that is not one. A number written with a national trunk prefix (`0…`) instead of its
 * country code is not the number `wa_id` holds, and matches nothing.
 */
export const whatsAppNumberKey = (raw: string): string | null => {
  const digits = raw.trim().replace(NUMBER_FORMATTING, "").replace(/^\+/u, "");
  return NUMBER_DIGITS.test(digits) ? digits : null;
};

/** A channel person key's id in the form its channel stores it; null when `raw` is not one. */
export const channelPersonKeyId = (kind: ChannelPersonKeyKind, raw: string): string | null => {
  switch (kind) {
    case "whatsapp_contact":
      return whatsAppNumberKey(raw);
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
