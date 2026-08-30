import { describe, expect, it } from 'vitest'

import { resolveConversationDisplayTitle } from '@/lib/conversation-title'

describe('resolveConversationDisplayTitle', () => {
  it('prefers the generated title when present', () => {
    expect(
      resolveConversationDisplayTitle({ title: 'Refund for order 4821', preview: 'hey' }),
    ).toBe('Refund for order 4821')
  })

  it('falls back to the stripped preview when no title has been generated yet', () => {
    expect(
      resolveConversationDisplayTitle({ title: null, preview: '**hey** there' }),
    ).toBe('hey there')
  })

  it('falls back to the stripped preview when title is omitted', () => {
    expect(resolveConversationDisplayTitle({ preview: 'howdy' })).toBe('howdy')
  })

  it('treats a blank or whitespace-only title as absent', () => {
    expect(resolveConversationDisplayTitle({ title: '   ', preview: 'howdy' })).toBe('howdy')
  })

  it('falls back to the generic label when neither title nor preview is usable', () => {
    expect(resolveConversationDisplayTitle({ title: null, preview: null })).toBe('Untitled conversation')
    expect(resolveConversationDisplayTitle({ title: '', preview: '' })).toBe('Untitled conversation')
  })

  it('accepts a custom fallback label', () => {
    expect(resolveConversationDisplayTitle({ title: null, preview: '' }, 'No messages yet')).toBe('No messages yet')
  })
})
