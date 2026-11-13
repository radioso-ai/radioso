'use client'

import { useId, useState, type ReactNode } from 'react'
import { Check, ExternalLink, ImageOff } from 'lucide-react'

import type { ChatUserInputMetadata, ReplyBlock } from '@/lib/api-types'
import {
  isSelectableItem,
  itemOpenUrl,
  itemPickMessage,
  pictureFrameOf,
  resolveReplyLayout,
  type ItemListLayout,
  type PictureFrame,
  type ReplyItem,
  type ReplyPicks,
} from '@/lib/reply-blocks'
import { cn } from '@/lib/utils'

type ReplyImage = NonNullable<ReplyItem['image']>

// The width each layout shows a picture at, so the browser loads the smallest sharp rendition.
const IMAGE_SIZES: Record<ItemListLayout, string> = {
  carousel: '160px',
  grid: '(min-width: 640px) 200px, 50vw',
  list: '56px',
}

const FRAME_CLASSES: Record<PictureFrame, string> = {
  portrait: 'aspect-[3/4]',
  landscape: 'aspect-[4/3]',
  square: 'aspect-square',
}

const FOCUS_RING = 'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'

/**
 * A picture in a frame of fixed shape, so the card keeps its size while the picture loads. A
 * picture that fails to load, such as one whose document was deleted, leaves the frame empty.
 */
function ItemPicture({ image, layout, className }: { image?: ReplyImage; layout: ItemListLayout; className?: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className={cn('flex items-center justify-center overflow-hidden bg-muted text-muted-foreground', className)}>
      {image && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- the server serves each picture at the widths in its srcSet
        <img
          src={image.src}
          srcSet={image.srcSet}
          sizes={IMAGE_SIZES[layout]}
          width={image.width}
          height={image.height}
          alt={image.alt}
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
          className="size-full object-contain"
        />
      ) : (
        <ImageOff aria-hidden="true" className="size-5 opacity-40" />
      )}
    </span>
  )
}

/**
 * The whole card as one link when the item has a page, a plain box otherwise. The link is named by
 * the item's title, or by its picture's alt when the title is empty, and described by the
 * description the card shows.
 */
function ItemLink({
  item,
  href,
  titleId,
  descriptionId,
  onOpen,
  className,
  children,
}: {
  item: ReplyItem
  href: string | null
  titleId: string
  descriptionId?: string
  onOpen?: (href: string) => void
  className: string
  children: ReactNode
}) {
  if (!href) {
    return <div className={className}>{children}</div>
  }
  const hasTitle = item.title.trim() !== ''
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-labelledby={hasTitle ? titleId : undefined}
      aria-label={hasTitle ? undefined : item.image?.alt || undefined}
      aria-describedby={descriptionId}
      onClick={() => onOpen?.(href)}
      className={cn(className, FOCUS_RING)}
    >
      {children}
    </a>
  )
}

const OpensPage = () => <ExternalLink aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />

interface ItemViewProps {
  item: ReplyItem
  href: string | null
  frame: PictureFrame
  onOpen?: (href: string) => void
}

function CarouselCard({ item, href, frame, onOpen }: ItemViewProps) {
  const titleId = useId()
  return (
    <ItemLink
      item={item}
      href={href}
      titleId={titleId}
      onOpen={onOpen}
      className="flex h-full flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-colors hover:bg-muted/50"
    >
      <ItemPicture image={item.image} layout="carousel" className={cn('w-full border-b', FRAME_CLASSES[frame])} />
      <span className="flex items-start gap-1 px-2.5 py-2 text-sm font-medium leading-snug">
        <span id={titleId} className="line-clamp-2 min-w-0 flex-1">{item.title}</span>
        {href ? <OpensPage /> : null}
      </span>
    </ItemLink>
  )
}

function GridTile({ item, href, frame, onOpen }: ItemViewProps) {
  const titleId = useId()
  return (
    <ItemLink item={item} href={href} titleId={titleId} onOpen={onOpen} className="block rounded-lg border border-transparent">
      <figure className="flex flex-col gap-1">
        <ItemPicture image={item.image} layout="grid" className={cn('w-full rounded-lg border', FRAME_CLASSES[frame])} />
        <figcaption className="flex items-start gap-1 text-xs leading-snug text-muted-foreground">
          <span id={titleId} className="line-clamp-2 min-w-0 flex-1">{item.title}</span>
          {href ? <OpensPage /> : null}
        </figcaption>
      </figure>
    </ItemLink>
  )
}

function ListRow({ item, href, onOpen }: ItemViewProps) {
  const titleId = useId()
  const descriptionId = useId()
  return (
    <ItemLink
      item={item}
      href={href}
      titleId={titleId}
      descriptionId={item.description ? descriptionId : undefined}
      onOpen={onOpen}
      className="flex items-center gap-3 rounded-lg border bg-card p-2 text-card-foreground transition-colors hover:bg-muted/50"
    >
      <ItemPicture image={item.image} layout="list" className="size-14 shrink-0 rounded-md" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span id={titleId} className="line-clamp-2 text-sm font-medium leading-snug">{item.title}</span>
        {item.description ? <span id={descriptionId} className="line-clamp-2 text-xs text-muted-foreground">{item.description}</span> : null}
      </span>
      {href ? <OpensPage /> : null}
    </ItemLink>
  )
}

const ITEM_VIEWS = { carousel: CarouselCard, grid: GridTile, list: ListRow } satisfies Record<ItemListLayout, unknown>

const LIST_CLASSES: Record<ItemListLayout, string> = {
  carousel: 'flex snap-x snap-mandatory scroll-px-1 gap-2 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:thin]',
  grid: 'grid grid-cols-2 gap-2 p-1 sm:grid-cols-3',
  list: 'flex flex-col gap-1.5 p-1',
}

const LIST_ITEM_CLASSES: Record<ItemListLayout, string> = {
  carousel: 'w-40 shrink-0 snap-start',
  grid: 'min-w-0',
  list: 'min-w-0',
}

/** How a reply's cards are picked from: what this thread knows was picked, and how to pick. */
interface ItemPicking {
  /** The id of the message whose reply shows the block. */
  messageId: string
  picks: ReplyPicks
  /** The Select button's label. */
  label: string
  /**
   * Sends a pick as the visitor's message. Absent where nothing can be picked now, such as the
   * read-only Inbox or while a reply is on its way: the pick, if any, still shows.
   */
  onPick?: (content: string, inputMetadata: ChatUserInputMetadata) => unknown
}

/**
 * The Select button under a card the visitor can pick. Once the reply was picked from, every card
 * of it is settled: the one picked shows pressed, and none can be picked again.
 */
function SelectItemButton({ item, picked, settled, label, onPick }: {
  item: ReplyItem
  picked: boolean
  settled: boolean
  label: string
  onPick?: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      disabled={settled || !onPick}
      onClick={onPick}
      className={cn(
        'mt-1 flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
        'enabled:hover:bg-muted/60 disabled:cursor-default',
        picked ? 'border-foreground bg-muted' : 'bg-card text-card-foreground disabled:opacity-60',
        FOCUS_RING,
      )}
    >
      {picked ? <Check aria-hidden="true" className="size-3.5" /> : null}
      {label}
      <span className="sr-only"> {item.title || item.image?.alt}</span>
    </button>
  )
}

/**
 * The items a reply presents, under its text: a carousel of cards, a gallery, or a list of rows
 * for any layout the chat does not draw. The block's caption names the list for assistive tech.
 * A block the visitor can pick from (`selection: single`) carries a Select button under each card.
 */
export function ItemListBlock({
  block,
  transformHref,
  onOpen,
  picking,
}: {
  block: ReplyBlock
  /** Rewrites an item's link before it is shown, as the reply's own links are. */
  transformHref?: (href: string) => string
  onOpen?: (href: string) => void
  picking?: ItemPicking
}) {
  const layout = resolveReplyLayout(block.layout)
  const ItemView = ITEM_VIEWS[layout]
  const frame = pictureFrameOf(block)
  const items = block.items.map((item) => {
    const url = itemOpenUrl(item)
    return { item, href: url ? transformHref?.(url) ?? url : null }
  })
  // Tabbing reaches only the cards with links, so when any card has none, the strip itself takes
  // focus and scrolls with the arrow keys to bring every card into view.
  const stripTakesFocus = layout === 'carousel' && items.some(({ href }) => !href)
  const pick = picking?.picks.get(picking.messageId)
  const pickedKey = pick?.blockId === block.id ? pick.itemKey : null

  return (
    <div
      role="list"
      aria-label={block.caption || undefined}
      tabIndex={stripTakesFocus ? 0 : undefined}
      className={cn(LIST_CLASSES[layout], stripTakesFocus && FOCUS_RING)}
    >
      {items.map(({ item, href }) => (
        <div role="listitem" key={item.key} data-picked={item.key === pickedKey || undefined} className={LIST_ITEM_CLASSES[layout]}>
          <ItemView item={item} href={href} frame={frame} onOpen={onOpen} />
          {picking && isSelectableItem(block, item) ? (
            <SelectItemButton
              item={item}
              picked={item.key === pickedKey}
              settled={pick !== undefined}
              label={picking.label}
              onPick={picking.onPick
                ? () => picking.onPick?.(...itemPickMessage({ messageId: picking.messageId, blockId: block.id, itemKey: item.key }, item))
                : undefined}
            />
          ) : null}
        </div>
      ))}
    </div>
  )
}
