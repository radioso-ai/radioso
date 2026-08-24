/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamWorkspaceEvents } from '@/lib/api-events'
import {
  canRetryWithFreshWorkspaceToken,
  refreshWorkspaceApiToken,
  requireWorkspaceApiToken,
} from '@/lib/api-client'

vi.mock('@/lib/api-client', () => ({
  API_BASE: '/backend/api/v1',
  requireWorkspaceApiToken: vi.fn(),
  canRetryWithFreshWorkspaceToken: vi.fn(),
  refreshWorkspaceApiToken: vi.fn(),
}))

const requireWorkspaceApiTokenMock = vi.mocked(requireWorkspaceApiToken)
const canRetryMock = vi.mocked(canRetryWithFreshWorkspaceToken)
const refreshMock = vi.mocked(refreshWorkspaceApiToken)

afterEach(() => vi.unstubAllGlobals())

describe('streamWorkspaceEvents', () => {
  it('uses bearer fetch streaming and parses ready and push frames', async () => {
    requireWorkspaceApiTokenMock.mockResolvedValue('workspace-token')
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'event: ready\r\ndata: {"workspaceId":"workspace-1"}\r\n\r\n'
          + 'event: push\r\ndata: {"resourceType":"document","resourceId":"document-1","workspaceId":"workspace-1","changeKind":"document.status_changed","version":4}\r\n\r\n',
        ))
        controller.close()
      },
    })))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const onReady = vi.fn()
    const onPush = vi.fn(() => controller.abort())

    await streamWorkspaceEvents({ onReady, onPush }, controller.signal)

    expect(fetchMock).toHaveBeenCalledWith('/backend/api/v1/events', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer workspace-token' }),
      signal: controller.signal,
    }))
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onPush).toHaveBeenCalledWith({
      resourceType: 'document',
      resourceId: 'document-1',
      workspaceId: 'workspace-1',
      changeKind: 'document.status_changed',
      version: 4,
    })
  })

  it('refreshes an expired cached token on 401 and retries instead of reconnecting stale', async () => {
    requireWorkspaceApiTokenMock.mockResolvedValue('stale-token')
    canRetryMock.mockImplementation((response: Response) => response.status === 401)
    refreshMock.mockImplementation(async (headers: Headers) => {
      headers.set('Authorization', 'Bearer fresh-token')
      return true
    })
    const encoder = new TextEncoder()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(
            'event: ready\r\ndata: {"workspaceId":"workspace-1"}\r\n\r\n'
            + 'event: push\r\ndata: {"resourceType":"document","resourceId":"document-1","workspaceId":"workspace-1","changeKind":"document.status_changed","version":7}\r\n\r\n',
          ))
          controller.close()
        },
      })))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const onReady = vi.fn()
    const onPush = vi.fn(() => controller.abort())

    await streamWorkspaceEvents({ onReady, onPush }, controller.signal)

    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const retryHeaders = fetchMock.mock.calls[1][1].headers as Headers
    expect(retryHeaders.get('Authorization')).toBe('Bearer fresh-token')
    expect(onReady).toHaveBeenCalledTimes(1)
    expect(onPush).toHaveBeenCalledTimes(1)
  })

  it.each([403, 404])('degrades to poll-only on terminal status %s', async (status) => {
    vi.useFakeTimers()
    requireWorkspaceApiTokenMock.mockResolvedValue('workspace-token')
    canRetryMock.mockReturnValue(false)
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    const streaming = streamWorkspaceEvents({ onReady: vi.fn(), onPush: vi.fn() }, controller.signal)
    await vi.advanceTimersByTimeAsync(60_000)
    await streaming

    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('does not reset reconnect backoff for streams that flap immediately after ready', async () => {
    vi.useFakeTimers()
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    requireWorkspaceApiTokenMock.mockResolvedValue('workspace-token')
    canRetryMock.mockReturnValue(false)
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n'))
        controller.close()
      },
    }))))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const streaming = streamWorkspaceEvents({ onReady: vi.fn(), onPush: vi.fn() }, controller.signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    controller.abort()
    await streaming
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    randomSpy.mockRestore()
    vi.useRealTimers()
  })
})
