import { describe, expect, it } from 'vitest'

import { humanReplyAuthor } from '@/lib/reply-attribution'

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
