import { describe, expect, it } from 'vitest'

import {
  FRONTEND_ERROR_RATE_WINDOW_MS,
  FRONTEND_ERROR_REPEAT_WINDOW_MS,
  FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW,
  createFrontendErrorReportLimiter,
} from '@/lib/frontend-error-report-limiter'

const stringRejection = {
  errorType: 'frontend.promise.unhandled',
  errorClass: 'string',
  message: 'rejected',
  path: '/embed-frame',
}

const manualClock = (start = 1_000_000) => {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

const distinct = (index: number) => ({ ...stringRejection, message: `rejected ${index}` })

describe('frontend error report limiter', () => {
  it('admits an error once and refuses its identical repeats inside the repeat window', () => {
    const clock = manualClock()
    const limiter = createFrontendErrorReportLimiter({ now: clock.now })

    expect(limiter.admit(stringRejection)).toBe(true)
    expect(limiter.admit({ ...stringRejection })).toBe(false)
    clock.advance(FRONTEND_ERROR_REPEAT_WINDOW_MS - 1)
    expect(limiter.admit({ ...stringRejection })).toBe(false)
  })

  it('admits a repeating error again once the repeat window since it was last admitted has passed', () => {
    const clock = manualClock()
    const limiter = createFrontendErrorReportLimiter({ now: clock.now })

    expect(limiter.admit(stringRejection)).toBe(true)
    clock.advance(FRONTEND_ERROR_REPEAT_WINDOW_MS / 2)
    expect(limiter.admit(stringRejection)).toBe(false)
    clock.advance(FRONTEND_ERROR_REPEAT_WINDOW_MS / 2)
    expect(limiter.admit(stringRejection)).toBe(true)
    clock.advance(FRONTEND_ERROR_REPEAT_WINDOW_MS - 1)
    expect(limiter.admit(stringRejection)).toBe(false)
    clock.advance(1)
    expect(limiter.admit(stringRejection)).toBe(true)
  })

  it('treats a change in type, class, message or path as a different error', () => {
    const limiter = createFrontendErrorReportLimiter({ now: manualClock().now })

    expect(limiter.admit(stringRejection)).toBe(true)
    expect(limiter.admit({ ...stringRejection, errorType: 'frontend.runtime.unhandled' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, errorClass: 'TypeError' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, errorClass: undefined })).toBe(true)
    expect(limiter.admit({ ...stringRejection, message: 'rejected again' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, path: '/chat/[token]' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, path: undefined })).toBe(true)
  })

  it('keeps fields apart, so shifting text between them does not collide', () => {
    const limiter = createFrontendErrorReportLimiter({ now: manualClock().now })

    expect(limiter.admit({ errorType: 'frontend.promise.unhandled', errorClass: 'a', message: 'b,c', path: '/p' })).toBe(true)
    expect(limiter.admit({ errorType: 'frontend.promise.unhandled', errorClass: 'a,b', message: 'c', path: '/p' })).toBe(true)
  })

  it('caps distinct errors per rolling rate window', () => {
    const clock = manualClock()
    const limiter = createFrontendErrorReportLimiter({ now: clock.now })

    const admitted = Array.from({ length: FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW + 50 }, (_, index) => (
      limiter.admit(distinct(index))
    ))

    expect(admitted.filter(Boolean)).toHaveLength(FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW)
    expect(admitted.slice(0, FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW).every(Boolean)).toBe(true)
  })

  it('frees rate budget as each admission leaves the rolling window', () => {
    const clock = manualClock()
    const limiter = createFrontendErrorReportLimiter({ now: clock.now })
    const half = FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW / 2

    for (let index = 0; index < half; index += 1) expect(limiter.admit(distinct(index))).toBe(true)
    clock.advance(FRONTEND_ERROR_RATE_WINDOW_MS / 2)
    for (let index = half; index < FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW; index += 1) expect(limiter.admit(distinct(index))).toBe(true)
    expect(limiter.admit(distinct(100))).toBe(false)

    clock.advance(FRONTEND_ERROR_RATE_WINDOW_MS / 2 - 1)
    expect(limiter.admit(distinct(101))).toBe(false)

    clock.advance(1)
    const afterFirstHalfExpired = Array.from({ length: half + 1 }, (_, index) => limiter.admit(distinct(200 + index)))
    expect(afterFirstHalfExpired.filter(Boolean)).toHaveLength(half)
  })

  it('does not spend the rate budget on refused repeats', () => {
    const limiter = createFrontendErrorReportLimiter({ now: manualClock().now, maxReportsPerRateWindow: 2 })

    expect(limiter.admit(stringRejection)).toBe(true)
    expect(limiter.admit(stringRejection)).toBe(false)
    expect(limiter.admit(stringRejection)).toBe(false)
    expect(limiter.admit({ ...stringRejection, message: 'second' })).toBe(true)
    expect(limiter.admit({ ...stringRejection, message: 'third' })).toBe(false)
  })

  it('keeps reporting a long-lived tab that has already used its budget', () => {
    const clock = manualClock()
    const limiter = createFrontendErrorReportLimiter({ now: clock.now })

    for (let index = 0; index < FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW; index += 1) limiter.admit(distinct(index))
    clock.advance(8 * 60 * 60 * 1000)

    expect(limiter.admit({ ...stringRejection, message: 'a regression later in the day' })).toBe(true)
  })

  it('forgets errors whose repeat window has passed, so memory stays bounded', () => {
    const clock = manualClock()
    const limiter = createFrontendErrorReportLimiter({ now: clock.now })

    for (let minute = 0; minute < 120; minute += 1) {
      for (let index = 0; index < FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW; index += 1) {
        limiter.admit(distinct(minute * 100 + index))
      }
      clock.advance(FRONTEND_ERROR_RATE_WINDOW_MS)
    }

    const ratesPerRepeatWindow = Math.ceil(FRONTEND_ERROR_REPEAT_WINDOW_MS / FRONTEND_ERROR_RATE_WINDOW_MS)
    expect(limiter.trackedErrorCount()).toBeLessThanOrEqual(FRONTEND_ERROR_REPORTS_PER_RATE_WINDOW * ratesPerRepeatWindow)

    clock.advance(FRONTEND_ERROR_REPEAT_WINDOW_MS)
    limiter.admit(stringRejection)
    expect(limiter.trackedErrorCount()).toBe(1)
  })

  it('gives each limiter its own budget', () => {
    const clock = manualClock()
    const first = createFrontendErrorReportLimiter({ now: clock.now, maxReportsPerRateWindow: 1 })
    const second = createFrontendErrorReportLimiter({ now: clock.now, maxReportsPerRateWindow: 1 })

    expect(first.admit(stringRejection)).toBe(true)
    expect(second.admit(stringRejection)).toBe(true)
  })
})
