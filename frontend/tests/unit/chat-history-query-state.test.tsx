// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryObserver, useQueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { chatApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import { fetchHistory, shouldClampHistoryPage } from '@/components/dashboard/history/history-list-query'
import { DashboardQueryProvider } from '@/components/providers/dashboard-query-provider'
import { useHistoryListQuery } from '@/components/dashboard/history/history-list-query'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    chatApi: {
      ...actual.chatApi,
      listHistory: vi.fn(),
      listChatHistory: vi.fn(),
      listContactHistory: vi.fn(),
      listSearchHistory: vi.fn(),
    },
  }
})

const response = { items: [], conversations: [], contacts: [], searches: [], total: 0, hasMore: false }

describe('history list query', () => {
  afterEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.body.replaceChildren()
  })
  const renderProbe = async (input: { workspaceId: string; variant: 'all' | 'chat'; page: number }, onState: (state: unknown, client: QueryClient) => void) => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const Probe = ({ value }: { value: typeof input }) => {
      const query = useHistoryListQuery({ ...value, pageSize: 50 })
      const client = useQueryClient()
      useEffect(() => { onState(query, client) }, [client, query])
      return null
    }
    const interest = {
      open: ({ onLifecycle }: { onLifecycle(signal: 'ready'): void }) => {
        onLifecycle('ready')
        return { close: vi.fn() }
      },
    } as never
    const render = async (value: typeof input) => {
      await act(async () => {
        root.render(<DashboardQueryProvider key={value.workspaceId} workspaceId={value.workspaceId} interest={interest}><Probe value={value} /></DashboardQueryProvider>)
      })
    }
    await render(input)
    return { root, container, render }
  }

  it('uses the policy gate and derives the 45–60 second interval', async () => {
    vi.mocked(chatApi.listHistory).mockResolvedValue(response as never)
    const states: unknown[] = []
    const { root, container } = await renderProbe({ workspaceId: 'workspace-1', variant: 'all', page: 1 }, (state, client) => {
      const query = client.getQueryCache().find({ queryKey: ['workspace', 'workspace-1', 'history', 'list', 'all', 1, 50] })
      states.push({ state, interval: (query?.options as { refetchInterval?: number }).refetchInterval })
    })
    await vi.waitFor(() => expect(chatApi.listHistory).toHaveBeenCalled())
    const interval = (states.at(-1) as { interval?: number }).interval
    expect(interval).toBeGreaterThanOrEqual(45_000)
    expect(interval).toBeLessThanOrEqual(60_000)
    root.unmount()
    container.remove()
  })

  it('does not call list APIs while the hidden policy gate is closed', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    const states: unknown[] = []
    const { root, container } = await renderProbe({ workspaceId: 'workspace-1', variant: 'all', page: 1 }, (state) => states.push(state))
    await Promise.resolve()
    expect(chatApi.listHistory).not.toHaveBeenCalled()
    root.unmount()
    container.remove()
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  })

  it('aborts the old hook query on filter switch and excludes its late result from both slices', async () => {
    let resolveAll!: (value: typeof response) => void
    const allResponse = new Promise<typeof response>((resolve) => { resolveAll = resolve })
    vi.mocked(chatApi.listHistory).mockReturnValueOnce(allResponse as never)
    vi.mocked(chatApi.listChatHistory).mockResolvedValueOnce(response as never)
    let client!: QueryClient
    const { root, container, render } = await renderProbe({ workspaceId: 'workspace-1', variant: 'all', page: 1 }, (_state, nextClient) => { client = nextClient })
    await vi.waitFor(() => expect(chatApi.listHistory).toHaveBeenCalled())
    const allKey = ['workspace', 'workspace-1', 'history', 'list', 'all', 1, 50] as const
    const chatKey = ['workspace', 'workspace-1', 'history', 'list', 'chat', 1, 50] as const
    await render({ workspaceId: 'workspace-1', variant: 'chat', page: 1 })
    await vi.waitFor(() => expect(chatApi.listChatHistory).toHaveBeenCalled())
    resolveAll({ ...response, items: [{ id: 'late' }] } as never)
    await vi.waitFor(() => expect(client.getQueryData(chatKey)).toMatchObject({ variant: 'chat' }))
    expect(vi.mocked(chatApi.listHistory).mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(client.getQueryData(allKey)).toBeUndefined()
    root.unmount()
    container.remove()
  })

  it.each([
    ['page', { workspaceId: 'workspace-1', variant: 'all' as const, page: 2 }],
    ['workspace', { workspaceId: 'workspace-2', variant: 'all' as const, page: 1 }],
  ])('aborts the old signal and keeps the old %s key free of late data', async (_kind, nextValue) => {
    let resolveOld!: (value: typeof response) => void
    const oldResponse = new Promise<typeof response>((resolve) => { resolveOld = resolve })
    vi.mocked(chatApi.listHistory).mockReturnValueOnce(oldResponse as never).mockResolvedValueOnce(response as never)
    let oldClient!: QueryClient
    let currentClient!: QueryClient
    const seenKeys: (readonly unknown[])[] = []
    const initial = { workspaceId: 'workspace-1', variant: 'all' as const, page: 1 }
    const { root, container, render } = await renderProbe(initial, (_state, client) => {
      currentClient = client
      seenKeys.push(...client.getQueryCache().getAll().map((query) => query.queryKey))
      if (!oldClient) oldClient = client
    })
    await vi.waitFor(() => expect(chatApi.listHistory).toHaveBeenCalled())
    const oldKey = ['workspace', 'workspace-1', 'history', 'list', 'all', 1, 50] as const
    await render(nextValue)
    await vi.waitFor(() => expect(chatApi.listHistory).toHaveBeenCalledTimes(2))
    resolveOld({ ...response, items: [{ id: 'late-old-slice' }] } as never)
    await vi.waitFor(() => expect(oldClient.getQueryData(oldKey)).toBeUndefined())
    expect(vi.mocked(chatApi.listHistory).mock.calls[0]?.[1]?.aborted).toBe(true)
    if (nextValue.workspaceId !== initial.workspaceId) {
      expect(currentClient).not.toBe(oldClient)
      const newKey = ['workspace', nextValue.workspaceId, 'history', 'list', 'all', 1, 50] as const
      expect(seenKeys).toContainEqual(newKey)
    } else {
      expect(currentClient).toBe(oldClient)
      const newKey = ['workspace', initial.workspaceId, 'history', 'list', 'all', 2, 50] as const
      await vi.waitFor(() => expect(currentClient.getQueryState(newKey)).toBeDefined())
    }
    await act(async () => root.unmount())
    container.remove()
  })

  it('revisits exact-key cached data and retains it through a hook background failure', async () => {
    const cachedResponse = { ...response, items: [{ id: 'distinctive-cached-row' }] }
    const backgroundFailure = Object.assign(new Error('background failure'), { status: 403 })
    vi.mocked(chatApi.listHistory).mockResolvedValueOnce(cachedResponse as never).mockRejectedValueOnce(backgroundFailure)
    vi.mocked(chatApi.listChatHistory).mockResolvedValueOnce(response as never)
    let client!: QueryClient
    const states: unknown[] = []
    const { root, container, render } = await renderProbe({ workspaceId: 'workspace-1', variant: 'all', page: 1 }, (state, nextClient) => {
      client = nextClient
      states.push(state)
    })
    await vi.waitFor(() => expect(chatApi.listHistory).toHaveBeenCalledTimes(1))
    await render({ workspaceId: 'workspace-1', variant: 'chat', page: 1 })
    await vi.waitFor(() => expect(chatApi.listChatHistory).toHaveBeenCalled())
    await render({ workspaceId: 'workspace-1', variant: 'all', page: 1 })
    const key = ['workspace', 'workspace-1', 'history', 'list', 'all', 1, 50] as const
    await vi.waitFor(() => expect(client.getQueryState(key)?.fetchStatus).toBe('idle'))
    expect(chatApi.listHistory).toHaveBeenCalledTimes(2)
    expect(client.getQueryData(key)).toEqual({ variant: 'all', response: cachedResponse })
    expect(client.getQueryState(key)?.error).toBeInstanceOf(Error)
    expect(client.getQueryState(key)?.error).toBe(backgroundFailure)
    await act(async () => root.unmount())
    container.remove()
  })

  it('list boundary never invokes detail or tail APIs; selection remains a separate drawer contract', async () => {
    const detail = vi.spyOn(chatApi, 'getHistoryConversation')
    const contact = vi.spyOn(chatApi, 'getContactHistory')
    const search = vi.spyOn(chatApi, 'getSearchHistory')
    const tail = vi.spyOn(hitlApi, 'tailConversation')
    const signal = new AbortController().signal
    for (const [variant, method] of [
      ['all', 'listHistory'],
      ['chat', 'listChatHistory'],
      ['contact', 'listContactHistory'],
      ['search', 'listSearchHistory'],
    ] as const) {
      vi.mocked(chatApi[method]).mockResolvedValue(response as never)
      await fetchHistory({ queryKey: ['workspace', 'workspace-1', 'history', 'list', variant, 1, 50], signal } as never)
    }
    expect(detail).not.toHaveBeenCalled()
    expect(contact).not.toHaveBeenCalled()
    expect(search).not.toHaveBeenCalled()
    expect(tail).not.toHaveBeenCalled()
    detail.mockRestore()
    contact.mockRestore()
    search.mockRestore()
    tail.mockRestore()
  })

  it.each([
    ['all', 'listHistory'],
    ['chat', 'listChatHistory'],
    ['contact', 'listContactHistory'],
    ['search', 'listSearchHistory'],
  ] as const)('selects the %s endpoint with exact paging and Query signal', async (variant, method) => {
    const signal = new AbortController().signal
    vi.mocked(chatApi[method]).mockResolvedValue(response as never)
    await fetchHistory({
      queryKey: ['workspace', 'workspace-1', 'history', 'list', variant, 3, 50],
      signal,
    } as never)
    expect(chatApi[method]).toHaveBeenCalledWith({ limit: 50, offset: 100 }, signal)
  })

  it('does not clamp an active page before its exact variant response arrives', () => {
    expect(shouldClampHistoryPage({ activeVariant: 'chat', loadedVariant: undefined, activePage: 3, totalPages: 1 })).toBe(false)
    expect(shouldClampHistoryPage({ activeVariant: 'chat', loadedVariant: 'all', activePage: 3, totalPages: 1 })).toBe(false)
    expect(shouldClampHistoryPage({ activeVariant: 'chat', loadedVariant: 'chat', activePage: 3, totalPages: 1 })).toBe(true)
  })

  it('isolates filter switches from late results and retains same-key data on background failure', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const first = Promise.withResolvers<typeof response>()
    const second = Promise.withResolvers<typeof response>()
    vi.mocked(chatApi.listHistory).mockReturnValueOnce(first.promise as never)
    vi.mocked(chatApi.listChatHistory).mockReturnValueOnce(second.promise as never)
    const observer = new QueryObserver(client, {
      queryKey: ['workspace', 'workspace-1', 'history', 'list', 'all', 1, 50],
      queryFn: fetchHistory,
      retry: false,
    })
    const states: unknown[] = []
    const unsubscribe = observer.subscribe((state) => states.push(state))
    observer.updateResult()
    observer.setOptions({ queryKey: ['workspace', 'workspace-1', 'history', 'list', 'chat', 1, 50], queryFn: fetchHistory, retry: false })
    first.resolve(response)
    second.resolve(response)
    await vi.waitFor(() => expect(observer.getCurrentResult().data).toMatchObject({ variant: 'chat' }))
    expect(states.some((state) => (state as { data?: { variant?: string } }).data?.variant === 'all')).toBe(false)

    const key = ['workspace', 'workspace-1', 'history', 'list', 'chat', 1, 50] as const
    client.setQueryData(key, { variant: 'chat', response })
    vi.mocked(chatApi.listChatHistory).mockRejectedValueOnce(new Error('background failure'))
    await client.refetchQueries({ queryKey: key })
    expect(client.getQueryData(key)).toMatchObject({ variant: 'chat' })
    unsubscribe()
  })
})
