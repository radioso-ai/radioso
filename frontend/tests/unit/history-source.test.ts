import { describe, expect, it } from 'vitest'

import { formatConversationSource, getConversationSourceBadge } from '@/lib/history-source'

describe('history source helpers', () => {
  it('formats MCP conversations with a friendly label', () => {
    expect(formatConversationSource('mcp', null)).toBe('MCP')
  })

  it('formats embedded conversations with the host when available', () => {
    expect(formatConversationSource('website_embed', 'https://example.com/path')).toBe('Embedded from example.com')
  })

  it('returns a badge for MCP conversations', () => {
    expect(getConversationSourceBadge('mcp')).toMatchObject({
      label: 'MCP',
    })
  })
})
