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
})
