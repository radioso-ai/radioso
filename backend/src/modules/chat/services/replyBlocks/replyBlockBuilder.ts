import type { ReplyAction, ReplyBlock, ReplyBlockLayout } from "@radioso/conversation-contract";

import {
  REPLY_BLOCK_LIMITS,
  type ReplyImageUrls,
  type StoredReplyBlock,
  type StoredReplyItem,
} from "../../contracts/replyBlocks.js";
import type { PresentHead } from "./presentHead.js";
import type { LedgerEntry, TurnImageLedger } from "./turnImageLedger.js";

/** Why a handle the model named did not become an item. */
export type ReplyBlockDropReason = "unknown_handle" | "duplicate_handle" | "over_limit";

interface ReplyBlockBuild {
  block: StoredReplyBlock | null;
  dropped: ReplyBlockDropReason[];
}

/** The only block a reply carries in this version; ids are unique within the message. */
const FIRST_BLOCK_ID = "b1";

/** A handle as the model may write it: `m3`, or `[m3]` as the prompt shows it. Structural. */
const HANDLE_PATTERN = /^\[?\s*(m\d{1,3})\s*\]?$/i;

const normalizeHandle = (value: string): string | null =>
  HANDLE_PATTERN.exec(value.trim())?.[1]?.toLowerCase() ?? null;

const truncate = (value: string, maxLength: number): string => Array.from(value).slice(0, maxLength).join("");

const httpAddress = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

/** A primary image stands for its document; an inline one is titled by what the page says of it. */
const itemTitle = (entry: LedgerEntry): string => {
  const own = entry.role === "inline" ? entry.caption?.trim() || entry.alt.trim() : "";
  return truncate(own || entry.documentTitle.trim(), REPLY_BLOCK_LIMITS.titleLength);
};

const toItem = (entry: LedgerEntry): StoredReplyItem => {
  const url = httpAddress(entry.sourceUrl);
  const actions: ReplyAction[] = url ? [{ type: "open", url }] : [];
  return {
    key: entry.imageId,
    title: itemTitle(entry),
    image: { imageId: entry.imageId, width: entry.width, height: entry.height, alt: entry.alt },
    actions,
  };
};

/**
 * The layout follows from what was picked, not from the model: the covers of several documents
 * form a carousel of cards, pictures from within a page a gallery grid. A client that does not
 * draw that layout gets a list.
 */
const layoutFor = (entries: readonly LedgerEntry[], declared: readonly ReplyBlockLayout[]): ReplyBlockLayout => {
  const layout: ReplyBlockLayout = entries.every((entry) => entry.role === "primary") ? "carousel" : "grid";
  return declared.includes(layout) ? layout : "list";
};

/**
 * Builds the reply block the model's `present` head asks for. Every item comes from this turn's
 * ledger, so a block can only show an image the turn's evidence carried: a handle the ledger does
 * not hold is dropped, and no model-written URL or title is ever used.
 */
export const buildReplyBlock = (input: {
  head: PresentHead;
  ledger: TurnImageLedger;
  layouts: readonly ReplyBlockLayout[];
}): ReplyBlockBuild => {
  const picked: LedgerEntry[] = [];
  const dropped: ReplyBlockDropReason[] = [];
  for (const value of input.head.images) {
    const handle = normalizeHandle(value);
    const entry = handle ? input.ledger.entry(handle) : undefined;
    if (!entry) {
      dropped.push("unknown_handle");
    } else if (picked.includes(entry)) {
      dropped.push("duplicate_handle");
    } else if (picked.length >= REPLY_BLOCK_LIMITS.items) {
      dropped.push("over_limit");
    } else {
      picked.push(entry);
    }
  }
  if (picked.length === 0) {
    return { block: null, dropped };
  }
  return {
    block: {
      type: "item_list",
      id: FIRST_BLOCK_ID,
      layout: layoutFor(picked, input.layouts),
      selection: "none",
      caption: truncate(input.head.caption.trim(), REPLY_BLOCK_LIMITS.captionLength),
      items: picked.map(toItem),
    },
    dropped,
  };
};

/** The blocks as a client receives them: each stored image id becomes the URLs it is served at. */
export const presentReplyBlocks = (blocks: readonly StoredReplyBlock[], urls: ReplyImageUrls): ReplyBlock[] =>
  blocks.map((block) => ({
    ...block,
    items: block.items.map(({ image, ...item }) => ({
      ...item,
      ...(image
        ? { image: { ...urls.forImage(image.imageId), width: image.width, height: image.height, alt: image.alt } }
        : {}),
    })),
  }));
