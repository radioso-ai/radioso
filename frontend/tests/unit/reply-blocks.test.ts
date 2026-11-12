import { describe, expect, it } from 'vitest'

import type { ReplyBlock } from '@/lib/api-types'
import { itemOpenUrl, pictureFrameOf, resolveReplyLayout, withReplyBlocksCapability } from '@/lib/reply-blocks'

type ReplyItem = ReplyBlock['items'][number]

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
})
