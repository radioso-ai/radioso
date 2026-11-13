import type {
  ItemListBlock,
  ReplyBlock,
  ReplyBlockLayout,
  ReplyImage,
  ReplyItem,
} from "@radioso/conversation-contract";
import { z } from "zod";

export type { ReplyBlock, ReplyBlockLayout } from "@radioso/conversation-contract";

export const REPLY_BLOCK_LAYOUTS = ["carousel", "grid", "list"] as const satisfies readonly ReplyBlockLayout[];

export const REPLY_BLOCK_LIMITS = {
  items: 10,
  captionLength: 120,
  titleLength: 160,
  descriptionLength: 400,
} as const;

/**
 * What a client declares it renders, under `clientContextCapabilities["reply.blocks"]`: each block
 * kind it renders, with the layouts it draws for that kind. A layout it leaves out reaches it as
 * `list`. Without the declaration, a reply carries no blocks.
 */
export interface ReplyBlocksCapability {
  item_list?: { layouts: ReplyBlockLayout[] };
}

/**
 * An image as a reply block stores it on the message: the image's id, never a URL, so a stored
 * block stays valid when the address the server is reached at changes. The URL is built each
 * time the block is presented.
 */
export interface StoredReplyImage {
  imageId: string;
  width: number;
  height: number;
  alt: string;
}

export type StoredReplyItem = Omit<ReplyItem, "image" | "facts"> & { image?: StoredReplyImage };

/**
 * Where a stored block's items came from, when not from the answer's evidence. Server-only: it is
 * kept on the message for whatever acts on a block later, and presenting a block never sends it.
 */
export type StoredReplyBlockOrigin = { kind: "skill_result"; skillName: string };

/** A reply block as `messages.metadata_json.blocks` keeps it. */
export type StoredReplyBlock = Omit<ItemListBlock, "items"> & { items: StoredReplyItem[]; origin?: StoredReplyBlockOrigin };

/** Builds the served addresses of a stored image: `src` at the larger width, `srcSet` at both. */
export interface ReplyImageUrls {
  forImage(imageId: string): Required<Pick<ReplyImage, "src" | "srcSet">>;
}

const replyActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open"), url: z.string().url().max(2048) }),
  z.object({ type: z.literal("select") }),
]);

const itemListBlockSchemaWith = <TImage extends z.ZodTypeAny>(imageSchema: TImage) => z.object({
  type: z.literal("item_list"),
  id: z.string().min(1).max(64),
  layout: z.enum(REPLY_BLOCK_LAYOUTS),
  selection: z.enum(["none", "single"]),
  caption: z.string().max(REPLY_BLOCK_LIMITS.captionLength),
  items: z.array(z.object({
    key: z.string().min(1).max(128),
    title: z.string().max(REPLY_BLOCK_LIMITS.titleLength),
    description: z.string().max(REPLY_BLOCK_LIMITS.descriptionLength).optional(),
    image: imageSchema.optional(),
    actions: z.array(replyActionSchema).max(2),
  })).min(1).max(REPLY_BLOCK_LIMITS.items),
});

const replyImageSchema = z.object({
  src: z.string().url(),
  alt: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  srcSet: z.string().optional(),
});

const storedReplyImageSchema = z.object({
  imageId: z.string().min(1).max(128),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string(),
});

/** A reply block as a client receives it. */
export const replyBlockSchema = itemListBlockSchemaWith(replyImageSchema) satisfies z.ZodType<ReplyBlock>;

/** A reply block as the message row stores it; history reads it back through this. */
export const storedReplyBlockSchema = itemListBlockSchemaWith(storedReplyImageSchema).extend({
  origin: z.object({ kind: z.literal("skill_result"), skillName: z.string().min(1).max(200) }).optional(),
}) satisfies z.ZodType<StoredReplyBlock>;

/**
 * The capability as the server keeps it for a turn, or null when the client declared none. Only
 * the layouts the server knows survive, in its own order.
 */
export const replyBlocksCapabilityFromRequest = (
  declared: { item_list?: { layouts: readonly string[] } } | undefined,
): ReplyBlocksCapability | null => {
  const itemList = declared?.item_list;
  if (!itemList) {
    return null;
  }
  return { item_list: { layouts: REPLY_BLOCK_LAYOUTS.filter((layout) => itemList.layouts.includes(layout)) } };
};

/** One card of a reply as a data-subject export carries it. */
interface ExportedReplyItem {
  title: string;
  description: string | null;
  link: string | null;
  imageId: string | null;
}

/**
 * The blocks an assistant message stored, as a data-subject export carries them: each card the
 * subject was shown, with its title, subtitle, link and picture's id. The server's own `origin`
 * stays out. Null when the message stored none that read back.
 */
export const replyBlocksForExport = (
  metadata: unknown,
): Array<{ id: string; layout: ReplyBlockLayout; caption: string; items: ExportedReplyItem[] }> | null => {
  const blocks = metadata && typeof metadata === "object" ? (metadata as { blocks?: unknown }).blocks : undefined;
  const parsed = storedReplyBlockSchema.array().min(1).safeParse(blocks);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.map((block) => ({
    id: block.id,
    layout: block.layout,
    caption: block.caption,
    items: block.items.map((item) => ({
      title: item.title,
      description: item.description ?? null,
      link: item.actions.find((action) => action.type === "open")?.url ?? null,
      imageId: item.image?.imageId ?? null,
    })),
  }));
};
