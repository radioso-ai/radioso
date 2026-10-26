import { describe, expect, it } from 'vitest'

import { humanReplyAuthor, teammateHasLatestReply } from '@/lib/reply-attribution'

describe('humanReplyAuthor', () => {
  const carlReply = { operatorLabel: 'carl@acme.example', operatorDisplayName: undefined }
  const danaReply = { operatorLabel: 'Dana Scully', operatorDisplayName: 'Acme Support' }

  it('names the teammate who replied to operators', () => {
    expect(humanReplyAuthor(carlReply, 'operator')).toBe('carl@acme.example')
    expect(humanReplyAuthor(danaReply, 'operator')).toBe('Dana Scully')
  })

  it('falls back to the signature, then to a generic teammate, for operators', () => {
    expect(humanReplyAuthor({ operatorDisplayName: 'Acme Support' }, 'operator')).toBe('Acme Support')
    expect(humanReplyAuthor({ operatorLabel: '  ', operatorDisplayName: ' ' }, 'operator')).toBe('A teammate')
    expect(humanReplyAuthor({}, 'operator')).toBe('A teammate')
  })

  it('shows the visitor only the signature, whatever else the message carries', () => {
    expect(humanReplyAuthor(danaReply, 'visitor')).toBe('Acme Support')
    expect(humanReplyAuthor(carlReply, 'visitor')).toBe('A teammate')
    expect(humanReplyAuthor({}, 'visitor')).toBe('A teammate')
  })
})

describe('teammateHasLatestReply', () => {
  const visitor = { role: 'user' as const, source: 'customer' as const }
  const agent = { role: 'assistant' as const, source: 'ai_agent' as const }
  const teammate = { role: 'assistant' as const, source: 'human_agent' as const }

  it('is false before anyone from the team has replied', () => {
    expect(teammateHasLatestReply([])).toBe(false)
    expect(teammateHasLatestReply([agent, visitor])).toBe(false)
    expect(teammateHasLatestReply([{ role: 'assistant' }])).toBe(false)
  })

  it('is true while a teammate wrote the latest reply, whatever the visitor wrote since', () => {
    expect(teammateHasLatestReply([agent, visitor, teammate])).toBe(true)
    expect(teammateHasLatestReply([agent, teammate, visitor, visitor])).toBe(true)
    expect(teammateHasLatestReply([visitor, { role: 'assistant', source: 'human_agent_on_behalf_of_ai_agent' }])).toBe(true)
  })

  it('is false once the agent replies again', () => {
    expect(teammateHasLatestReply([teammate, visitor, agent])).toBe(false)
  })
})
