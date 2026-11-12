import type { ReplyAction, ReplyBlockLayout } from "@radioso/conversation-contract";

import { isPubliclyReachableHostname } from "../../../../shared/domain/publicNetwork.js";
import type { ToolImageSource } from "../../../toolImages/contracts/index.js";
import { REPLY_BLOCK_LIMITS, type StoredReplyBlock, type StoredReplyItem } from "../../contracts/replyBlocks.js";
import type { RecordPresentHead } from "./recordPresentHead.js";
import { resolveJsonPointer, type ToolRecord, type ToolRecordLedger } from "./toolRecords.js";

/** Why a record the model named, or a field it pointed at, did not reach a card. Bounded: each is a metric label. */
export type RecordBlockDropReason =
  | "unknown_record"
  | "duplicate_record"
  | "over_limit"
  | "title_unresolved"
  | "field_unresolved";

interface RecordBlockBuild {
  block: StoredReplyBlock | null;
  dropped: RecordBlockDropReason[];
  /** The pictures the block's cards show, for the reply's transaction to record. */
  toolImages: ToolImageSource[];
}

/** The only block a reply carries in this version; ids are unique within the message. */
const FIRST_BLOCK_ID = "b1";

/** A handle as the model may write it: `r3`, or `[r3]` as the prompt shows it. Structural. */
const HANDLE_PATTERN = /^\[?\s*(r\d{1,3})\s*\]?$/i;

/** The longest address a card keeps, as the block contract allows. */
const MAX_URL_LENGTH = 2048;

/**
 * A tool image's size is unknown until it is copied, and the card is built before that: cards
 * frame it as landscape, the shape most listing and product photos have, and fit it inside.
 */
const TOOL_IMAGE_FRAME = { width: 640, height: 480 } as const;

const normalizeHandle = (value: string): string | null =>
  HANDLE_PATTERN.exec(value.trim())?.[1]?.toLowerCase() ?? null;

const truncate = (value: string, maxLength: number): string => Array.from(value).slice(0, maxLength).join("");

/** Plain text from a resolved value: a string or a finite number, on one line; anything else is not text. */
const textOf = (value: unknown): string | null => {
  const text = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  const line = text?.replace(/\s+/g, " ").trim();
  return line ? line : null;
};

/**
 * A public http(s) address, or null. Its host must be one the public internet can reach by its
 * literal form, and it carries no credentials; anything else, `javascript:` included, is no address.
 */
const publicAddress = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !isPubliclyReachableHostname(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
};

/**
 * Builds the cards the model's `present` head asks for from a skill's records. Every value on a
 * card comes from the record the model named, at the pointer it named: a handle the turn did not
 * offer is dropped, a title that is not text drops its card, and a field that is not what it must
 * be (a public address for a picture or a link) is left off that card, never invented. A picture
 * is either one the skill returned as bytes this turn or a public address, which gets a new id to
 * be copied under; the card stores only the id.
 */
export const buildRecordBlock = (input: {
  head: RecordPresentHead;
  ledger: ToolRecordLedger;
  layouts: readonly ReplyBlockLayout[];
  skillName: string;
  newImageId: () => string;
}): RecordBlockBuild => {
  const dropped: RecordBlockDropReason[] = [];
  const picked: ToolRecord[] = [];
  for (const value of input.head.records) {
    const handle = normalizeHandle(value);
    const record = handle ? input.ledger.record(handle) : undefined;
    if (!record) {
      dropped.push("unknown_record");
    } else if (picked.includes(record)) {
      dropped.push("duplicate_record");
    } else if (picked.length >= REPLY_BLOCK_LIMITS.items) {
      dropped.push("over_limit");
    } else {
      picked.push(record);
    }
  }

  const toolImages: ToolImageSource[] = [];
  const imageIdsByUrl = new Map<string, string>();
  const imageFor = (value: unknown): string | null => {
    const inline = input.ledger.mediaImageId(value);
    if (inline) {
      if (!toolImages.some((source) => source.imageId === inline)) toolImages.push({ kind: "inline", imageId: inline });
      return inline;
    }
    const url = publicAddress(value);
    if (!url) return null;
    const known = imageIdsByUrl.get(url);
    if (known) return known;
    const imageId = input.newImageId();
    imageIdsByUrl.set(url, imageId);
    toolImages.push({ kind: "url", imageId, url });
    return imageId;
  };

  const { fields } = input.head;
  const items: StoredReplyItem[] = [];
  for (const record of picked) {
    const title = textOf(resolveJsonPointer(record.value, fields.title));
    if (!title) {
      dropped.push("title_unresolved");
      continue;
    }
    const optional = <T>(pointer: string | null, read: (value: unknown) => T | null): T | undefined => {
      if (pointer === null) return undefined;
      const value = read(resolveJsonPointer(record.value, pointer));
      if (value === null) dropped.push("field_unresolved");
      return value ?? undefined;
    };
    const description = optional(fields.subtitle, textOf);
    const link = optional(fields.link, publicAddress);
    const imageId = optional(fields.image, imageFor);
    const shownTitle = truncate(title, REPLY_BLOCK_LIMITS.titleLength);
    const actions: ReplyAction[] = link ? [{ type: "open", url: link }] : [];
    items.push({
      key: record.key,
      title: shownTitle,
      ...(description ? { description: truncate(description, REPLY_BLOCK_LIMITS.descriptionLength) } : {}),
      ...(imageId ? { image: { imageId, ...TOOL_IMAGE_FRAME, alt: shownTitle } } : {}),
      actions,
    });
  }

  if (items.length === 0) {
    return { block: null, dropped, toolImages: [] };
  }
  const shownImageIds = new Set(items.flatMap((item) => (item.image ? [item.image.imageId] : [])));
  // A carousel of cards when the cards have pictures, a list when none does; a client that does
  // not draw a carousel gets a list.
  const layout: ReplyBlockLayout = shownImageIds.size > 0 && input.layouts.includes("carousel") ? "carousel" : "list";
  return {
    block: {
      type: "item_list",
      id: FIRST_BLOCK_ID,
      layout,
      selection: "none",
      caption: truncate(input.head.caption.trim(), REPLY_BLOCK_LIMITS.captionLength),
      items,
      origin: { kind: "skill_result", skillName: input.skillName },
    },
    dropped,
    toolImages: toolImages.filter((source) => shownImageIds.has(source.imageId)),
  };
};
