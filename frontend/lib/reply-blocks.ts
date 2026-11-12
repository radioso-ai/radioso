import type { ClientContextCapabilities, ReplyBlock } from './api-types'

type ReplyItem = ReplyBlock['items'][number]

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
