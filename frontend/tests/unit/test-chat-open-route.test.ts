import { describe, expect, it } from 'vitest'

import { followRoute, routeIdForLoaded } from '@/lib/test-chat-open-route'

const executionA = '11111111-1111-4111-8111-111111111111'
const executionB = '22222222-2222-4222-8222-222222222222'

describe('followRoute', () => {
  it('adopts the loaded test when the route names none, e.g. returning from another tab', () => {
    expect(followRoute(undefined, executionA)).toEqual({ action: 'adopt', executionId: executionA })
  })

  it('does nothing when neither the route nor anything loaded names a test', () => {
    expect(followRoute(undefined, undefined)).toEqual({ action: 'none' })
  })

  it('does nothing when the route already names what is loaded', () => {
    expect(followRoute(executionA, executionA)).toEqual({ action: 'none' })
  })

  it('rejects a route id that is not a UUID, e.g. a mistyped or truncated shared link', () => {
    expect(followRoute('not-a-uuid', undefined)).toEqual({ action: 'reject' })
    expect(followRoute('not-a-uuid', executionA)).toEqual({ action: 'reject' })
  })

  it('opens a route id that names a different, validly shaped test', () => {
    expect(followRoute(executionB, executionA)).toEqual({ action: 'open', executionId: executionB })
    expect(followRoute(executionB, undefined)).toEqual({ action: 'open', executionId: executionB })
  })
})

describe('routeIdForLoaded', () => {
  it('leaves the URL alone when the load has not changed since the last check', () => {
    expect(routeIdForLoaded(executionA, executionA, executionA)).toEqual({ write: false })
    expect(routeIdForLoaded(undefined, undefined, undefined)).toEqual({ write: false })
  })

  it('leaves the URL alone when a route id still differs from what was previously loaded, since a link still opening owns it', () => {
    expect(routeIdForLoaded(executionB, executionA, undefined)).toEqual({ write: false })
  })

  it('leaves the URL alone when the route already names the current load', () => {
    expect(routeIdForLoaded(executionA, undefined, executionA)).toEqual({ write: false })
  })

  it('writes the newly loaded id when starting a test with no route id yet, e.g. a first message or greeting', () => {
    expect(routeIdForLoaded(undefined, undefined, executionA)).toEqual({ write: true, executionId: executionA })
  })

  it('writes the newly loaded id when a different saved test replaces the one the route named', () => {
    expect(routeIdForLoaded(executionA, executionA, executionB)).toEqual({ write: true, executionId: executionB })
  })

  it('writes a cleared id when the loaded test is cleared while the route still names it, e.g. a mode change', () => {
    expect(routeIdForLoaded(executionA, executionA, undefined)).toEqual({ write: true, executionId: null })
  })
})
