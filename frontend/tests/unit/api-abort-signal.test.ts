import { afterEach, describe, expect, it, vi } from 'vitest'

const workspaceId = 'workspace-1'
const storage = (values: Record<string, string> = {}) => {
  const entries = new Map(Object.entries(values))
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value), removeItem: (key: string) => entries.delete(key) }
}
const jsonResponse = (payload: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': 'application/json' }), json: async () => payload } as Response)

describe('request cancellation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects before token acquisition without fetching and preserves the caller reason', async () => {
    const reason = new DOMException('pre-aborted', 'AbortError')
    const controller = new AbortController()
    controller.abort(reason)
    const fetchMock = vi.fn()
    vi.stubGlobal('window', { localStorage: storage({ 'radioso.activeWorkspaceId': workspaceId }) })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    await expect(request('/document/', { method: 'GET', signal: controller.signal }, { withApiToken: true })).rejects.toBe(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('detaches an aborted caller while initial token acquisition continues for shared callers', async () => {
    let resolveToken!: (response: Response) => void
    const tokenResponse = new Promise<Response>((resolve) => { resolveToken = resolve })
    const fetchMock = vi.fn().mockReturnValueOnce(tokenResponse).mockResolvedValueOnce(jsonResponse({ ok: true }))
    const controller = new AbortController()
    vi.stubGlobal('window', { localStorage: storage({ 'radioso.activeWorkspaceId': workspaceId }) })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    const pending = request('/document/', { method: 'GET', signal: controller.signal }, { withApiToken: true })
    const reason = new DOMException('token acquisition aborted', 'AbortError')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    expect(fetchMock).toHaveBeenCalledOnce()
    resolveToken(jsonResponse({ token: 'token-1' }))
    await tokenResponse
  })

  it('shares pending token acquisition after an aborted caller detaches', async () => {
    let resolveToken!: (response: Response) => void
    const tokenResponse = new Promise<Response>((resolve) => { resolveToken = resolve })
    const fetchMock = vi.fn().mockReturnValueOnce(tokenResponse).mockResolvedValueOnce(jsonResponse({ ok: true }))
    const controller = new AbortController()
    vi.stubGlobal('window', { localStorage: storage({ 'radioso.activeWorkspaceId': workspaceId }) })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    const first = request('/document/', { method: 'GET', signal: controller.signal }, { withApiToken: true })
    const reason = new DOMException('first caller aborted', 'AbortError')
    controller.abort(reason)
    await expect(first).rejects.toBe(reason)
    const second = request('/document/', { method: 'GET' }, { withApiToken: true })
    expect(fetchMock).toHaveBeenCalledOnce()
    resolveToken(jsonResponse({ token: 'shared-token' }))
    await expect(second).resolves.toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not retry after abort before a 401 refresh completes', async () => {
    let resolveToken!: (response: Response) => void
    const tokenResponse = new Promise<Response>((resolve) => { resolveToken = resolve })
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401)).mockReturnValueOnce(tokenResponse)
    const controller = new AbortController()
    vi.stubGlobal('window', { localStorage: storage({ 'radioso.activeWorkspaceId': workspaceId, 'radioso.workspaceTokens': JSON.stringify({ [workspaceId]: 'stale-token' }) }) })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    const pending = request('/document/', { method: 'GET', signal: controller.signal }, { withApiToken: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const reason = new DOMException('refresh aborted', 'AbortError')
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    resolveToken(jsonResponse({ token: 'fresh-token' }))
    await tokenResponse
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('shares one refresh acquisition between stale-token callers while one waiter aborts', async () => {
    let resolveToken!: (response: Response) => void
    const tokenResponse = new Promise<Response>((resolve) => { resolveToken = resolve })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401))
      .mockReturnValueOnce(tokenResponse)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
    const firstController = new AbortController()
    vi.stubGlobal('window', { localStorage: storage({ 'radioso.activeWorkspaceId': workspaceId, 'radioso.workspaceTokens': JSON.stringify({ [workspaceId]: 'stale-token' }) }) })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    const first = request('/document/', { method: 'GET', signal: firstController.signal }, { withApiToken: true })
    const second = request('/document/', { method: 'GET' }, { withApiToken: true })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const reason = new DOMException('one waiter aborted', 'AbortError')
    firstController.abort(reason)
    resolveToken(jsonResponse({ token: 'fresh-token' }))
    await expect(first).rejects.toBe(reason)
    await expect(second).resolves.toEqual({ ok: true })
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/account/workspaces/'))).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('evicts a rejected shared token acquisition so a later call retries acquisition', async () => {
    let rejectToken!: (error: Error) => void
    let resolveToken!: (response: Response) => void
    const firstToken = new Promise<Response>((_resolve, reject) => { rejectToken = reject })
    const secondToken = new Promise<Response>((resolve) => { resolveToken = resolve })
    const fetchMock = vi.fn().mockReturnValueOnce(firstToken).mockReturnValueOnce(secondToken).mockResolvedValueOnce(jsonResponse({ ok: true }))
    vi.stubGlobal('window', { localStorage: storage({ 'radioso.activeWorkspaceId': workspaceId }) })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    const first = request('/document/', { method: 'GET' }, { withApiToken: true })
    rejectToken(new Error('token unavailable'))
    await expect(first).rejects.toThrow('token unavailable')
    const second = request('/document/', { method: 'GET' }, { withApiToken: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    resolveToken(jsonResponse({ token: 'recovered-token' }))
    await expect(second).resolves.toEqual({ ok: true })
  })

  it('does not start refresh when an initial resource response arrives after abort', async () => {
    let resolveResource!: (response: Response) => void
    const resourceResponse = new Promise<Response>((resolve) => { resolveResource = resolve })
    const fetchMock = vi.fn().mockReturnValue(resourceResponse)
    const controller = new AbortController()
    vi.stubGlobal('window', { localStorage: storage({ 'radioso.activeWorkspaceId': workspaceId, 'radioso.workspaceTokens': JSON.stringify({ [workspaceId]: 'cached-token' }) }) })
    vi.stubGlobal('fetch', fetchMock)
    const { request } = await import('@/lib/api-client')
    const pending = request('/document/', { method: 'GET', signal: controller.signal }, { withApiToken: true })
    const reason = new DOMException('resource aborted', 'AbortError')
    controller.abort(reason)
    resolveResource(jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401))
    await expect(pending).rejects.toBe(reason)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('does not turn an AbortError from response decoding into an HTTP error', async () => {
    const abortError = new DOMException('body aborted', 'AbortError')
    const response = { ok: false, status: 500, headers: new Headers({ 'content-type': 'application/json' }), json: vi.fn().mockRejectedValue(abortError) } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('window', { localStorage: storage() })
    vi.stubGlobal('fetch', fetchMock)
    const { buildError } = await import('@/lib/api-client')
    await expect(buildError(response)).rejects.toBe(abortError)
  })
})
