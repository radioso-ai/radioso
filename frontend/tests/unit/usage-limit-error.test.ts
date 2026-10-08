import { describe, expect, it } from 'vitest'

import { getUsageLimitNotice } from '@/lib/usage-limit-error'

const usageLimitError = (resource: string) => ({
  status: 429,
  error: {
    code: 'usage_limit_exceeded',
    message: 'Usage limit exceeded',
    details: { resource, limit: 100, used: 100 },
  },
})

describe('getUsageLimitNotice', () => {
  it('returns a conversations notice for monthly_conversations', () => {
    expect(getUsageLimitNotice(usageLimitError('monthly_conversations'))).toEqual({
      resource: 'monthly_conversations',
      message: "This month's conversations are used up.",
    })
  })

  it('returns the same conversations notice for monthly_answers', () => {
    expect(getUsageLimitNotice(usageLimitError('monthly_answers'))).toEqual({
      resource: 'monthly_answers',
      message: "This month's conversations are used up.",
    })
  })

  it('returns a document-limit notice for stored_documents', () => {
    expect(getUsageLimitNotice(usageLimitError('stored_documents'))).toEqual({
      resource: 'stored_documents',
      message: "Your plan's document limit is reached.",
    })
  })

  it('returns a storage-full notice for stored_indexed_bytes', () => {
    expect(getUsageLimitNotice(usageLimitError('stored_indexed_bytes'))).toEqual({
      resource: 'stored_indexed_bytes',
      message: "Your plan's storage is full.",
    })
  })

  it('returns an indexing-allowance notice for monthly_indexed_bytes', () => {
    expect(getUsageLimitNotice(usageLimitError('monthly_indexed_bytes'))).toEqual({
      resource: 'monthly_indexed_bytes',
      message: "This month's indexing allowance is used up.",
    })
  })

  it('falls back to a generic sentence for an unrecognized resource', () => {
    expect(getUsageLimitNotice(usageLimitError('something_new'))).toEqual({
      resource: null,
      message: "Your plan's usage limit is reached.",
    })
  })

  it('falls back to a generic sentence when details are missing entirely', () => {
    expect(getUsageLimitNotice({ status: 429, error: { code: 'usage_limit_exceeded', message: 'Usage limit exceeded' } })).toEqual({
      resource: null,
      message: "Your plan's usage limit is reached.",
    })
  })

  it('returns null for a non-usage-limit error', () => {
    expect(getUsageLimitNotice({ status: 429, error: { code: 'rate_limit_exceeded', message: 'Please wait' } })).toBeNull()
    expect(getUsageLimitNotice(new Error('network failure'))).toBeNull()
    expect(getUsageLimitNotice(null)).toBeNull()
    expect(getUsageLimitNotice(undefined)).toBeNull()
  })
})
