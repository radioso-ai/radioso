import { describe, expect, it } from 'vitest'

import { getApiErrorStatus } from '@/lib/api-error'

describe('getApiErrorStatus', () => {
  it('reads the HTTP status attached by the API client', () => {
    expect(getApiErrorStatus({
      status: 404,
      error: { code: 'NOT_FOUND', message: 'Missing' },
    })).toBe(404)
  })

  it('ignores malformed and non-HTTP errors', () => {
    expect(getApiErrorStatus({ status: '404' })).toBeUndefined()
    expect(getApiErrorStatus(new Error('network failure'))).toBeUndefined()
  })
})
