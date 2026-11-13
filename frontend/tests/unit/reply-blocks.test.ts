import { describe, expect, it } from 'vitest'

import type { ReplyBlock } from '@/lib/api-types'
import {
  isRenderableReplyBlock,
  isSelectableItem,
  itemOpenUrl,
  itemPickMessage,
  replyPicks,
  pictureFrameOf,
  resolveReplyLayout,
  withReplyBlocksCapability,
  type ReplyItem,
} from '@/lib/reply-blocks'

const item = (actions: ReplyItem['actions']): ReplyItem => ({ key: 'item-1', title: 'Garden room', actions })

const blockOf = (...sizes: Array<[number, number] | null>): ReplyBlock => ({
  type: 'item_list',
  id: 'block-1',
  layout: 'carousel',
  selection: 'none',
  caption: 'Guides',
  items: sizes.map((size, index) => ({
    key: `item-${index}`,
    title: `Guide ${index}`,
    ...(size ? { image: { src: `https://app.example/image-${index}`, alt: '', width: size[0], height: size[1] } } : {}),
    actions: [],
  })),
})

describe('reply blocks', () => {
  it('declares the layouts the chat draws beside the host page capabilities', () => {
    const pageRead = { available: true, mode: 'metadata' as const, supportedOperations: ['metadata' as const] }

    expect(withReplyBlocksCapability({ 'page.read': pageRead })).toEqual({
      'page.read': pageRead,
      'reply.blocks': { item_list: { layouts: ['carousel', 'grid'] } },
    })
    expect(withReplyBlocksCapability()).toEqual({
      'reply.blocks': { item_list: { layouts: ['carousel', 'grid'] } },
    })
  })

  it('draws carousels and grids as sent and any other layout as a list', () => {
    expect(resolveReplyLayout('carousel')).toBe('carousel')
    expect(resolveReplyLayout('grid')).toBe('grid')
    expect(resolveReplyLayout('list')).toBe('list')
    expect(resolveReplyLayout('mosaic')).toBe('list')
  })

  it('links an item only to a web page', () => {
    expect(itemOpenUrl(item([{ type: 'open', url: 'https://stay.example/rooms/garden' }]))).toBe('https://stay.example/rooms/garden')
    expect(itemOpenUrl(item([{ type: 'select' }, { type: 'open', url: 'http://stay.example/rooms' }]))).toBe('http://stay.example/rooms')
    expect(itemOpenUrl(item([{ type: 'open', url: 'javascript:alert(1)' }]))).toBeNull()
    expect(itemOpenUrl(item([{ type: 'open', url: 'not a url' }]))).toBeNull()
    expect(itemOpenUrl(item([{ type: 'select' }]))).toBeNull()
  })

  it('frames a block\'s pictures by the shape they share', () => {
    expect(pictureFrameOf(blockOf([640, 960], [600, 900], null))).toBe('portrait')
    expect(pictureFrameOf(blockOf([640, 480], [1200, 630]))).toBe('landscape')
    expect(pictureFrameOf(blockOf([640, 960], [640, 480]))).toBe('square')
    expect(pictureFrameOf(blockOf(null))).toBe('square')
  })

  it('draws an item list and leaves out a block of any kind it does not know', () => {
    expect(isRenderableReplyBlock(blockOf([640, 960]))).toBe(true)
    expect(isRenderableReplyBlock({ type: 'item_detail', id: 'block-2', item: { key: 'item-1', title: 'Garden room' } })).toBe(false)
    expect(isRenderableReplyBlock({ type: 'item_list', id: 'block-3' })).toBe(false)
    expect(isRenderableReplyBlock(null)).toBe(false)
  })
})

describe('picking a card (#1763)', () => {
  const selection = { messageId: 'assistant-1', blockId: 'block-1', itemKey: 'item-2' }

  it('sends the card title as the message, with the pick as its input metadata', () => {
    expect(itemPickMessage(selection, item([{ type: 'select' }]))).toEqual([
      'Garden room',
      { method: 'item_select', selection },
    ])
    // A card without a title is named by its picture.
    expect(itemPickMessage(selection, { key: 'item-2', title: ' ', image: { src: 'https://app.example/i', alt: 'A garden room', width: 1, height: 1 }, actions: [] })[0])
      .toBe('A garden room')
  })

  it('reads what was picked from each reply out of the visitor messages, so a reload shows it', () => {
    const picks = replyPicks([
      { role: 'assistant' },
      { role: 'user', inputMetadata: { method: 'item_select', selection } },
      { role: 'user', inputMetadata: { method: 'typed' } },
      // An assistant message never picks.
      { role: 'assistant', inputMetadata: { method: 'item_select', selection: { ...selection, messageId: 'assistant-2' } } },
    ])

    expect([...picks]).toEqual([['assistant-1', { blockId: 'block-1', itemKey: 'item-2' }]])
  })

  it('offers a pick only on a block that lets the visitor pick one, for an item that offers it', () => {
    const selectable = { ...blockOf([1, 1]), selection: 'single' as const }

    expect(isSelectableItem(selectable, item([{ type: 'select' }]))).toBe(true)
    expect(isSelectableItem(selectable, item([]))).toBe(false)
    expect(isSelectableItem(blockOf([1, 1]), item([{ type: 'select' }]))).toBe(false)
  })
})
