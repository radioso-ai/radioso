import { afterEach, describe, expect, it, vi } from 'vitest'

const storage = () => ({ getItem: (key: string) => key === 'radioso.activeWorkspaceId' ? 'workspace-1' : null, setItem: vi.fn(), removeItem: vi.fn() })
const jsonResponse = (payload: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => payload } as Response)

describe('request cancellation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects before fetching and preserves the caller reason', async () => {
    const reason = new DOMException('pre-aborted', 'AbortError')
    const controller = new AbortController()
    controller.abort(reason)
    const fetchMock = vi.fn()
    vi.stubGlobal('window', { localStorage: storage() })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    await expect(request('/document/', { method: 'GET', signal: controller.signal }, { withSession: true })).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses one session request and never starts token acquisition or retry after a 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401))
    vi.stubGlobal('window', { localStorage: storage() })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    await expect(request('/document/', { method: 'GET' }, { withSession: true })).rejects.toMatchObject({ status: 401 })
    expect(fetchMock).toHaveBeenCalledOnce()
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('include')
    expect(new Headers(init.headers).get('Authorization')).toBeNull()
  })

  it('does not turn an AbortError from response decoding into an HTTP error', async () => {
    const abortError = new DOMException('body aborted', 'AbortError')
    const response = { ok: false, status: 500, headers: new Headers({ 'content-type': 'application/json' }), json: vi.fn().mockRejectedValue(abortError) } as unknown as Response
    const { buildError } = await import('@/lib/api-client')
    await expect(buildError(response)).rejects.toBe(abortError)
  })
})
