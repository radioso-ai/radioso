import { describe, expect, it } from 'vitest'

import type { ChatConversationDetail } from '@/lib/api-types'
import { mergeOlderMessages } from '@/lib/merge-older-messages'

const detail = (overrides: Record<string, unknown>) => ({ messages: [], ...overrides }) as unknown as ChatConversationDetail

describe('mergeOlderMessages', () => {
  it('puts the older messages first and keeps the first page\'s attributes and whether they are editable', () => {
    const attributes = [{ name: 'topic' }]
    const merged = mergeOlderMessages(
      detail({ messages: [{ id: 'm2' }], attributes, attributesEditable: true }),
      detail({ messages: [{ id: 'm1' }] }),
    )
    expect(merged.messages.map((message) => message.id)).toEqual(['m1', 'm2'])
    expect(merged.attributes).toBe(attributes)
    expect(merged.attributesEditable).toBe(true)
  })

  it('keeps a first page that says attributes are not editable', () => {
    expect(mergeOlderMessages(detail({ attributesEditable: false }), detail({})).attributesEditable).toBe(false)
  })

  it('returns the older page when nothing is open', () => {
    const older = detail({})
    expect(mergeOlderMessages(null, older)).toBe(older)
  })
})
