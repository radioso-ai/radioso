// Reply blocks: typed, structured parts of an assistant reply that a channel renders beside its
// text. A block is a semantic template built from a few shared primitives (text, image, link,
// action), never a free-form layout tree, so every channel can map it to its own message format.

/** Every reply block kind. A server sends only the kinds a client declared it renders. */
export type ReplyBlock = ItemListBlock;

/**
 * How an item list is laid out. A client that meets a layout it does not know renders the
 * block as `list`.
 */
export type ReplyBlockLayout = "carousel" | "grid" | "list";

/** A list of items a reply presents, such as product covers or the photos of a page. */
export interface ItemListBlock {
  type: "item_list";
  /** Unique within the message. */
  id: string;
  layout: ReplyBlockLayout;
  /** `single` when the visitor can pick one item; `none` when the items are only shown. */
  selection: "none" | "single";
  /** Model-written, at most 120 characters: the block's accessible label. */
  caption: string;
  /** One to ten items, in display order. */
  items: ReplyItem[];
}

/** One item of a block. An item is any source with a title and a picture, not only a product. */
export interface ReplyItem {
  /** A stable id of the item's source, unique within the block. */
  key: string;
  /** Plain text taken from the content, at most 160 characters. */
  title: string;
  /** Plain text, at most 400 characters. */
  description?: string;
  image?: ReplyImage;
  /** Labelled facts about the item. Part of the design; no server produces them yet. */
  facts?: ReplyFact[];
  /** `open` when the item has a link; `select` when the block's selection is `single`. */
  actions: ReplyAction[];
}

/** A picture the server serves itself. `src` is opaque: clients never learn where it came from. */
export interface ReplyImage {
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Responsive candidates for `src`, in the HTML `srcset` syntax. */
  srcSet?: string;
}

export type ReplyAction = { type: "open"; url: string } | { type: "select" };

/** A labelled fact about an item: text, a number with a unit, an amount of money, or a date. */
export type ReplyFact =
  | { kind: "text"; label: string; text: string }
  | { kind: "quantity"; label: string; value: number; unit?: string }
  | { kind: "money"; label: string; amount: string; currency: string }
  | { kind: "date"; label: string; date: string };
