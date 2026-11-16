import { describe, expect, it } from 'vitest'

import {
  FRONTEND_ERROR_REPORTS_PER_PAGE_MAX,
  createFrontendErrorReportLimiter,
} from '@/lib/frontend-error-report-limiter'

const stringRejection = {
  errorType: 'frontend.promise.unhandled',
  errorClass: 'string',
  message: 'rejected',
  path: '/embed-frame',
}

describe('frontend error report limiter', () => {
  it('admits an error once and refuses its identical repeats', () => {
    const limiter = createFrontendErrorReportLimiter()

    expect(limiter.admit(stringRejection)).toBe(true)
    expect(limiter.admit({ ...stringRejection })).toBe(false)
    expect(limiter.admit({ ...stringRejection })).toBe(false)
  })

  it('treats a change in type, class, message or path as a different error', () => {
    const limiter = createFrontendErrorReportLimiter()

    expect(limiter.admit(stringRejection)).toBe(true)
    expect(limiter.admit({ ...stringRejection, errorType: 'frontend.runtime.unhandled' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, errorClass: 'TypeError' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, errorClass: undefined })).toBe(true)
    expect(limiter.admit({ ...stringRejection, message: 'rejected again' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, path: '/chat/[token]' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, path: undefined })).toBe(true)
  })

  it('keeps fields apart, so shifting text between them does not collide', () => {
    const limiter = createFrontendErrorReportLimiter()

    expect(limiter.admit({ errorType: 'frontend.promise.unhandled', errorClass: 'a', message: 'b,c', path: '/p' })).toBe(true)
    expect(limiter.admit({ errorType: 'frontend.promise.unhandled', errorClass: 'a,b', message: 'c', path: '/p' })).toBe(true)
  })

  it('stops admitting distinct errors once the page has used its cap', () => {
    const limiter = createFrontendErrorReportLimiter()

    const admitted = Array.from({ length: FRONTEND_ERROR_REPORTS_PER_PAGE_MAX + 50 }, (_, index) => (
      limiter.admit({ ...stringRejection, message: `rejected ${index}` })
    ))

    expect(admitted.filter(Boolean)).toHaveLength(FRONTEND_ERROR_REPORTS_PER_PAGE_MAX)
    expect(admitted.slice(0, FRONTEND_ERROR_REPORTS_PER_PAGE_MAX).every(Boolean)).toBe(true)
  })

  it('does not spend the cap on refused repeats', () => {
    const limiter = createFrontendErrorReportLimiter(2)

    expect(limiter.admit(stringRejection)).toBe(true)
    expect(limiter.admit(stringRejection)).toBe(false)
    expect(limiter.admit(stringRejection)).toBe(false)
    expect(limiter.admit({ ...stringRejection, message: 'second' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, message: 'third' })).toBe(false)
  })

  it('gives each limiter its own budget', () => {
    const first = createFrontendErrorReportLimiter(1)
    const second = createFrontendErrorReportLimiter(1)

    expect(first.admit(stringRejection)).toBe(true)
    expect(second.admit(stringRejection)).toBe(true)
  })
})
