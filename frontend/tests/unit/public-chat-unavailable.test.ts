import { describe, expect, it } from 'vitest'

import { DEFAULT_WEBSITE_EMBED_COPY } from '@/lib/embed-widget'
import { publicChatUnavailableMessage, publicChatUnavailableReasonOf } from '@/lib/public-chat-unavailable'

describe('why a public chat cannot go on', () => {
  it('tells an agent nobody has published apart from a link that is gone, by the API error code alone', () => {
    expect(publicChatUnavailableReasonOf('agent_not_published')).toBe('agent_unavailable')
    expect(publicChatUnavailableReasonOf('not_found')).toBe('link_inactive')
  })

  it('leaves the chat open for any other error, or none', () => {
    expect(publicChatUnavailableReasonOf('usage_limit_exceeded')).toBeNull()
    expect(publicChatUnavailableReasonOf('toString')).toBeNull()
    expect(publicChatUnavailableReasonOf(undefined)).toBeNull()
  })

  it('says the agent is not available rather than that the link is gone, and keeps the link copy for a gone link', () => {
    expect(publicChatUnavailableMessage('agent_unavailable', DEFAULT_WEBSITE_EMBED_COPY)).toBe(DEFAULT_WEBSITE_EMBED_COPY.publicChatAgentUnavailableMessage)
    expect(publicChatUnavailableMessage('link_inactive', DEFAULT_WEBSITE_EMBED_COPY)).toBe(DEFAULT_WEBSITE_EMBED_COPY.publicChatUnavailableMessage)
  })
})
