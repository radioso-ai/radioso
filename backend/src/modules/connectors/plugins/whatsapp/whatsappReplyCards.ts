import type { ReplyBlock, ReplyItem } from "@radioso/conversation-contract";

/**
 * How a reply's cards (an `item_list` reply block) become WhatsApp Cloud API messages. Pure: it
 * knows Meta's message shapes and limits, and nothing of chat, documents or where the cards came
 * from. Limits as Meta's Cloud API documents them (read 2026-11-11).
 */
export const WHATSAPP_MESSAGE_LIMITS = {
  /** A carousel's and a reply-button message's body. */
  interactiveBody: 1024,
  /** A list message's body, and a text message's. */
  textBody: 4096,
  carouselCards: { min: 2, max: 10 },
  /** A carousel card's own text, with at most two line breaks. */
  cardBody: 160,
  cardBodyLineBreaks: 2,
  buttonLabel: 20,
  listRows: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  listSectionTitle: 24,
  imageCaption: 1024,
  /** The most image messages a gallery sends. */
  galleryImages: 4,
} as const;

type ImageHeader = { type: "image"; image: { link: string } };

type CarouselCardAction =
  | { buttons: Array<{ type: "quick_reply"; quick_reply: { id: string; title: string } }> }
  | { name: "cta_url"; parameters: { display_text: string; url: string } };

interface CarouselCard {
  card_index: number;
  // Meta's own quick-reply example keeps `cta_url` here as well.
  type: "cta_url";
  header: ImageHeader;
  body?: { text: string };
  action: CarouselCardAction;
}

type Interactive =
  | { type: "carousel"; body: { text: string }; action: { cards: CarouselCard[] } }
  | {
    type: "button";
    header?: ImageHeader;
    body: { text: string };
    action: { buttons: Array<{ type: "reply"; reply: { id: string; title: string } }> };
  }
  | {
    type: "list";
    body: { text: string };
    action: { button: string; sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }> };
  };

/** One message to the Cloud API's `/messages` endpoint, without `messaging_product` and `to`. */
export type WhatsAppOutboundMessage =
  | { type: "text"; text: { body: string } }
  | { type: "image"; image: { link: string; caption?: string } }
  | { type: "interactive"; interactive: Interactive };

/** The kind of message the cards went as: a bounded metric label. */
export type WhatsAppCardsMessageType = "carousel" | "button" | "list" | "image";

/** A message of a cards reply: the model's own text, or the cards. */
export interface WhatsAppReplyPart {
  role: "text" | "cards";
  message: WhatsAppOutboundMessage;
}

/**
 * How a block goes out: as cards (the model's text first when it does not fit the message's
 * body); as the text with a numbered list when the reply left out a button label the message needs;
 * or as the text alone when no WhatsApp message carries the block.
 */
export type WhatsAppCardsRendering =
  | { kind: "cards"; messageType: WhatsAppCardsMessageType; textSentFirst: boolean; parts: WhatsAppReplyPart[] }
  | { kind: "labels_missing"; messageType: WhatsAppCardsMessageType }
  | { kind: "text_only" };

const characters = (value: string): string[] => Array.from(value);

/** Text cut to `max` characters, never inside a character, with an ellipsis where it was cut. */
const fit = (value: string, max: number): string => {
  const chars = characters(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
};

const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

/** The words a card is known by: its title, else its picture's alt text, else its key. */
const itemName = (item: ReplyItem): string => oneLine(item.title) || oneLine(item.image?.alt ?? "") || item.key;

const openUrl = (item: ReplyItem): string | undefined => item.actions.find((action) => action.type === "open")?.url;

const usableLabel = (value: string | undefined): string | undefined => {
  const label = value?.trim();
  return label && characters(label).length <= WHATSAPP_MESSAGE_LIMITS.buttonLabel ? label : undefined;
};

const text = (body: string): WhatsAppOutboundMessage => ({ type: "text", text: { body } });

/**
 * The cards as a numbered text list: each card's name, and its page on the next line. The fallback
 * wherever the cards cannot go as interactive messages; a typed number or name still resolves where
 * the reply kept the items.
 */
const numberedItemList = (block: ReplyBlock): string =>
  block.items
    .map((item, index) => {
      const link = openUrl(item);
      return `${index + 1}. ${itemName(item)}${link ? `\n${link}` : ""}`;
    })
    .join("\n");

/**
 * The text messages a reply falls back to: the model's text (unless it already went) and the
 * numbered list, as one message when both fit, otherwise one after the other.
 */
export const fallbackTextMessages = (replyText: string | null, block: ReplyBlock): WhatsAppOutboundMessage[] => {
  const list = numberedItemList(block);
  const lead = replyText?.trim();
  if (!lead) {
    return [text(fit(list, WHATSAPP_MESSAGE_LIMITS.textBody))];
  }
  const combined = `${lead}\n\n${list}`;
  return characters(combined).length <= WHATSAPP_MESSAGE_LIMITS.textBody
    ? [text(combined)]
    : [text(fit(lead, WHATSAPP_MESSAGE_LIMITS.textBody)), text(fit(list, WHATSAPP_MESSAGE_LIMITS.textBody))];
};

/**
 * Where the model's text goes: in the message's body when it fits, otherwise as its own message
 * first, with the block's caption as the body.
 */
const placeText = (replyText: string, block: ReplyBlock, bodyLimit: number): { body: string; textFirst: boolean } => {
  const lead = replyText.trim();
  const caption = oneLine(block.caption);
  if (lead && characters(lead).length <= bodyLimit) {
    return { body: lead, textFirst: false };
  }
  if (caption) {
    return { body: fit(caption, bodyLimit), textFirst: lead.length > 0 };
  }
  return { body: fit(lead || itemName(block.items[0]), bodyLimit), textFirst: false };
};

/** A card's own text: its name, then its subtitle, on at most two lines. */
const cardBody = (item: ReplyItem): string => {
  const subtitle = item.description ? oneLine(item.description) : "";
  return fit(subtitle ? `${itemName(item)}\n${subtitle}` : itemName(item), WHATSAPP_MESSAGE_LIMITS.cardBody);
};

const imageHeader = (src: string): ImageHeader => ({ type: "image", image: { link: src } });

const withText = (replyText: string, textFirst: boolean, cards: WhatsAppOutboundMessage[]): WhatsAppReplyPart[] => [
  ...(textFirst ? [{ role: "text" as const, message: text(fit(replyText.trim(), WHATSAPP_MESSAGE_LIMITS.textBody)) }] : []),
  ...cards.map((message) => ({ role: "cards" as const, message })),
];

const carousel = (
  replyText: string,
  block: ReplyBlock,
  action: (item: ReplyItem, index: number) => CarouselCardAction,
): WhatsAppCardsRendering => {
  const { body, textFirst } = placeText(replyText, block, WHATSAPP_MESSAGE_LIMITS.interactiveBody);
  const cards = block.items.map((item, index): CarouselCard => ({
    card_index: index,
    type: "cta_url",
    header: imageHeader(item.image!.src),
    body: { text: cardBody(item) },
    action: action(item, index),
  }));
  return {
    kind: "cards",
    messageType: "carousel",
    textSentFirst: textFirst,
    parts: withText(replyText, textFirst, [{ type: "interactive", interactive: { type: "carousel", body: { text: body }, action: { cards } } }]),
  };
};

const imageMessage = (item: ReplyItem): WhatsAppOutboundMessage => {
  const link = openUrl(item);
  return {
    type: "image",
    image: { link: item.image!.src, caption: fit(link ? `${itemName(item)}\n${link}` : itemName(item), WHATSAPP_MESSAGE_LIMITS.imageCaption) },
  };
};

/**
 * Renders a reply's block as WhatsApp messages. `tapId` names the item at an index in the ids its
 * buttons and rows carry, so a tap comes back as that item.
 *
 * | Block | Message |
 * |---|---|
 * | Selectable, 2–10 items, all with pictures | Carousel, one quick-reply button per card |
 * | Not selectable, 2–10 items, all with pictures and links | Carousel, one URL button per card |
 * | Not selectable, all with pictures, some without links | Up to 4 image messages, each captioned with its name |
 * | 1 item with a picture | Image message; a reply-button message with the picture as header if selectable |
 * | Selectable, some without pictures | List message |
 * | Anything else | The model's text alone |
 */
export const renderReplyCards = (input: {
  text: string;
  block: ReplyBlock;
  tapId: (itemIndex: number) => string;
}): WhatsAppCardsRendering => {
  const { text: replyText, block, tapId } = input;
  const items = block.items;
  const count = items.length;
  const allPictured = count > 0 && items.every((item) => Boolean(item.image?.src));
  const selectLabel = usableLabel(block.buttonLabels?.select);
  const openLabel = usableLabel(block.buttonLabels?.open);
  const { min, max } = WHATSAPP_MESSAGE_LIMITS.carouselCards;

  if (count === 0 || count > max) {
    return { kind: "text_only" };
  }

  if (block.selection === "single") {
    if (allPictured && count >= min) {
      return selectLabel
        ? carousel(replyText, block, (_item, index) => ({ buttons: [{ type: "quick_reply", quick_reply: { id: tapId(index), title: selectLabel } }] }))
        : { kind: "labels_missing", messageType: "carousel" };
    }
    if (allPictured) {
      if (!selectLabel) {
        return { kind: "labels_missing", messageType: "button" };
      }
      const { body, textFirst } = placeText(replyText, block, WHATSAPP_MESSAGE_LIMITS.interactiveBody);
      return {
        kind: "cards",
        messageType: "button",
        textSentFirst: textFirst,
        parts: withText(replyText, textFirst, [{
          type: "interactive",
          interactive: {
            type: "button",
            header: imageHeader(items[0].image!.src),
            body: { text: body },
            action: { buttons: [{ type: "reply", reply: { id: tapId(0), title: selectLabel } }] },
          },
        }]),
      };
    }
    if (!selectLabel) {
      return { kind: "labels_missing", messageType: "list" };
    }
    const { body, textFirst } = placeText(replyText, block, WHATSAPP_MESSAGE_LIMITS.textBody);
    const rows = items.map((item, index) => {
      const name = itemName(item);
      const fitsTitle = characters(name).length <= WHATSAPP_MESSAGE_LIMITS.listRowTitle;
      const description = fitsTitle ? (item.description ? oneLine(item.description) : "") : name;
      return {
        id: tapId(index),
        title: fit(name, WHATSAPP_MESSAGE_LIMITS.listRowTitle),
        ...(description ? { description: fit(description, WHATSAPP_MESSAGE_LIMITS.listRowDescription) } : {}),
      };
    });
    return {
      kind: "cards",
      messageType: "list",
      textSentFirst: textFirst,
      parts: withText(replyText, textFirst, [{
        type: "interactive",
        interactive: {
          type: "list",
          body: { text: body },
          action: {
            button: selectLabel,
            sections: [{ title: fit(oneLine(block.caption) || selectLabel, WHATSAPP_MESSAGE_LIMITS.listSectionTitle), rows }],
          },
        },
      }]),
    };
  }

  if (!allPictured) {
    return { kind: "text_only" };
  }
  if (count === 1) {
    return { kind: "cards", messageType: "image", textSentFirst: replyText.trim().length > 0, parts: withText(replyText, replyText.trim().length > 0, [imageMessage(items[0])]) };
  }
  if (items.every((item) => openUrl(item))) {
    return openLabel
      ? carousel(replyText, block, (item) => ({ name: "cta_url", parameters: { display_text: openLabel, url: openUrl(item)! } }))
      : { kind: "labels_missing", messageType: "carousel" };
  }
  const gallery = items.slice(0, WHATSAPP_MESSAGE_LIMITS.galleryImages).map(imageMessage);
  return { kind: "cards", messageType: "image", textSentFirst: replyText.trim().length > 0, parts: withText(replyText, replyText.trim().length > 0, gallery) };
};
