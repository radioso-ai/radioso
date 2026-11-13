import type { ChatUserInputMetadata, ClientContextCapabilities, ReplyBlock } from './api-types'

export type ReplyItem = ReplyBlock['items'][number]

/** A card a visitor picked: the reply's message, the block, and the item's key. */
export type ItemSelection = NonNullable<ChatUserInputMetadata['selection']>

/** What was picked from one reply, read from the visitor messages; a reply is picked from once. */
export type ReplyPicks = ReadonlyMap<string, Omit<ItemSelection, 'messageId'>>

/**
 * What picking a card sends: the card's title as the visitor's message, and the pick. The server
 * reads the item from the reply it was on and stores the item's own title.
 */
export const itemPickMessage = (selection: ItemSelection, item: ReplyItem): [string, ChatUserInputMetadata] => [
  item.title.trim() || item.image?.alt.trim() || item.key,
  { method: 'item_select', selection },
]

/**
 * The card picked from each reply, keyed by the reply's message id, read from the visitor messages
 * that picked them: history keeps them, so a reload shows what was picked.
 */
export const replyPicks = (messages: readonly { role: string; inputMetadata?: ChatUserInputMetadata }[]): ReplyPicks =>
  new Map(messages.flatMap(({ role, inputMetadata }) => {
    const selection = role === 'user' && inputMetadata?.method === 'item_select' ? inputMetadata.selection : undefined
    return selection ? [[selection.messageId, { blockId: selection.blockId, itemKey: selection.itemKey }] as const] : []
  }))

/** Whether a visitor can pick the item: its block lets them pick one, and the item offers it. */
export const isSelectableItem = (block: ReplyBlock, item: ReplyItem): boolean =>
  block.selection === 'single' && item.actions.some((action) => action.type === 'select')

/** The item list layouts the chat draws. The server sends any other layout as `list`. */
const DRAWN_ITEM_LIST_LAYOUTS = ['carousel', 'grid'] as const

export type ItemListLayout = (typeof DRAWN_ITEM_LIST_LAYOUTS)[number] | 'list'

/**
 * The request's capabilities: the host page's, plus the reply blocks the chat renders. Only the
 * chat declares `reply.blocks`, since only it knows what it draws.
 */
export const withReplyBlocksCapability = (
  hostCapabilities?: ClientContextCapabilities,
): ClientContextCapabilities => ({
  ...hostCapabilities,
  'reply.blocks': { item_list: { layouts: [...DRAWN_ITEM_LIST_LAYOUTS] } },
})

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * Whether the chat draws a block. History returns stored blocks of every kind, including kinds
 * newer than this chat, and the chat leaves those out rather than fail on them.
 */
export const isRenderableReplyBlock = (block: unknown): block is ReplyBlock =>
  isRecord(block) && block.type === 'item_list' && Array.isArray(block.items)

const isDrawnLayout = (layout: string): layout is (typeof DRAWN_ITEM_LIST_LAYOUTS)[number] =>
  (DRAWN_ITEM_LIST_LAYOUTS as readonly string[]).includes(layout)

/** How an item list is drawn: as its layout when the chat draws it, otherwise as a list. */
export const resolveReplyLayout = (layout: string): ItemListLayout =>
  isDrawnLayout(layout) ? layout : 'list'

export type PictureFrame = 'portrait' | 'landscape' | 'square'

const shapeOf = ({ width, height }: { width: number; height: number }): PictureFrame =>
  height > width ? 'portrait' : width > height ? 'landscape' : 'square'

/**
 * The one frame a block's pictures share, so its cards line up: portrait when every picture is
 * taller than wide, such as book covers; landscape when every one is wider; square otherwise.
 */
export const pictureFrameOf = (block: ReplyBlock): PictureFrame => {
  const shapes = block.items.flatMap(({ image }) => (image ? [shapeOf(image)] : []))
  const [first] = shapes
  return first && shapes.every((shape) => shape === first) ? first : 'square'
}

/** The page an item opens, when it has one on the web. */
export const itemOpenUrl = (item: ReplyItem): string | null => {
  for (const action of item.actions) {
    if (action.type !== 'open') continue
    try {
      const { protocol } = new URL(action.url)
      if (protocol === 'https:' || protocol === 'http:') return action.url
    } catch {
      continue
    }
  }
  return null
}
