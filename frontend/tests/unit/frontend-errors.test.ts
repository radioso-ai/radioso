import { describe, expect, it, vi } from 'vitest'

import {
  BeaconFrontendErrorSink,
  FRONTEND_ERROR_COMPONENT_STACK_MAX_LENGTH,
  FRONTEND_ERROR_MESSAGE_MAX_LENGTH,
  FRONTEND_ERROR_STACK_MAX_LENGTH,
  createFrontendErrorReporter,
  sanitizeFrontendErrorPath,
  serializeFrontendThrowable,
} from '@/lib/frontend-errors'

describe('frontend error reporting', () => {
  it('reports generic frontend errors to configured sinks', async () => {
    const sink = {
      record: vi.fn().mockResolvedValue(undefined),
    }
    const reporter = createFrontendErrorReporter({
      now: () => '2026-04-22T10:00:00.000Z',
      sinks: [sink],
    })

    const event = await reporter.report({
      errorType: 'frontend.react.unhandled',
      error: new TypeError('Dashboard render failed'),
      componentStack: '\n    at Dashboard',
      path: '/w/acme/chat?token=secret',
      source: 'frontend',
    })

    expect(event).toEqual(expect.objectContaining({
      errorType: 'frontend.react.unhandled',
      errorClass: 'TypeError',
      message: 'Dashboard render failed',
      path: '/w/[workspaceKey]/chat',
      source: 'frontend',
      timestamp: '2026-04-22T10:00:00.000Z',
    }))
    expect(sink.record).toHaveBeenCalledWith(event)
  })

  it('uses beacon transport without exposing components to vendor code', async () => {
    const send = vi.fn().mockResolvedValue(true)
    const sink = new BeaconFrontendErrorSink({
      endpoint: '/api/v1/observability/frontend-errors',
      send,
    })

    await sink.record({
      errorType: 'frontend.runtime.unhandled',
      message: 'boom',
      path: '/w/[workspaceKey]/chat',
      source: 'frontend',
      timestamp: '2026-04-22T10:00:00.000Z',
    })

    expect(send).toHaveBeenCalledWith(
      '/api/v1/observability/frontend-errors',
      expect.stringContaining('"errorType":"frontend.runtime.unhandled"'),
    )
  })

  it('sanitizes paths and serializes non-error throwables', () => {
    expect(sanitizeFrontendErrorPath('/invite/super-secret-token?token=secret')).toBe('/invite/[token]')
    expect(sanitizeFrontendErrorPath('https://app.example/embed/embed-token#secret')).toBe('/embed/[token]')
    expect(serializeFrontendThrowable('plain failure')).toEqual({
      errorClass: 'string',
      message: 'plain failure',
    })
  })

  it('truncates the client envelope before delivery', async () => {
    const sink = {
      record: vi.fn().mockResolvedValue(undefined),
    }
    const reporter = createFrontendErrorReporter({ sinks: [sink] })

    await reporter.report({
      errorType: 'frontend.react.unhandled',
      message: 'm'.repeat(FRONTEND_ERROR_MESSAGE_MAX_LENGTH + 10),
      stack: 's'.repeat(FRONTEND_ERROR_STACK_MAX_LENGTH + 10),
      componentStack: 'c'.repeat(FRONTEND_ERROR_COMPONENT_STACK_MAX_LENGTH + 10),
      source: 'frontend',
    })

    expect(sink.record).toHaveBeenCalledWith(expect.objectContaining({
      message: 'm'.repeat(FRONTEND_ERROR_MESSAGE_MAX_LENGTH),
      stack: 's'.repeat(FRONTEND_ERROR_STACK_MAX_LENGTH),
      componentStack: 'c'.repeat(FRONTEND_ERROR_COMPONENT_STACK_MAX_LENGTH),
    }))
  })
})
