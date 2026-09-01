/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  issue: vi.fn(),
  rotate: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('@/lib/api-agent-channel-credentials', () => ({ agentChannelCredentialsApi: apiMocks }))

import { AgentChannelCredentialManager } from '@/components/dashboard/settings/agent-channel-credential-manager'

const credential = {
  id: 'credential-1', audience: 'mcp' as const, label: 'Desktop', prefix: 'rdso_abc', status: 'active' as const,
  createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null,
}

const makeCredential = (overrides: Partial<typeof credential> = {}) => ({ ...credential, ...overrides })

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

const findButton = (text: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes(text))

const fillLabel = (root: ParentNode, value: string) => {
  const input = root.querySelector<HTMLInputElement>('#mcp-credential-label')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, value)
  input?.dispatchEvent(new Event('input', { bubbles: true }))
  input?.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('AgentChannelCredentialManager', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    apiMocks.list.mockResolvedValue({ credentials: [], nextCursor: null })
    apiMocks.issue.mockResolvedValue({ credential, secret: 'one-time-secret' })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('clears one-time secret and prior inventory immediately when agent audience changes', async () => {
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="mcp" />)
    })
    const label = container.querySelector<HTMLInputElement>('#mcp-credential-label')
    const create = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Create credential'))
    expect(label).toBeTruthy()
    expect(create).toBeTruthy()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(label, 'Desktop')
      label!.dispatchEvent(new Event('input', { bubbles: true }))
      label!.dispatchEvent(new Event('change', { bubbles: true }))
      create!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.textContent).toContain('Shown once')

    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })

    expect(container.textContent).not.toContain('Shown once')
    expect(container.textContent).not.toContain('one-time-secret')
  })

  it('ignores a delayed inventory response from the previous agent audience', async () => {
    const oldList = deferred<{ credentials: typeof credential[]; nextCursor: string | null }>()
    const newList = deferred<{ credentials: typeof credential[]; nextCursor: string | null }>()
    apiMocks.list.mockReset()
    apiMocks.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise)

    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="mcp" />)
    })
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })

    await act(async () => {
      oldList.resolve({ credentials: [makeCredential({ label: 'Old audience' })], nextCursor: null })
    })
    expect(container.textContent).not.toContain('Old audience')

    await act(async () => {
      newList.resolve({ credentials: [makeCredential({ label: 'Current audience' })], nextCursor: null })
    })
    expect(container.textContent).toContain('Current audience')
  })

  it('ignores a delayed issue response from the previous agent audience', async () => {
    const issue = deferred<{ credential: typeof credential; secret: string }>()
    apiMocks.issue.mockReturnValue(issue.promise)

    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="mcp" />)
    })
    fillLabel(container, 'Old audience')
    await act(async () => {
      findButton('Create credential')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })
    await act(async () => {
      issue.resolve({ credential: makeCredential({ label: 'Old issued credential' }), secret: 'old-secret' })
    })

    expect(container.textContent).not.toContain('Shown once')
    expect(container.textContent).not.toContain('Old issued credential')
    expect(container.textContent).not.toContain('old-secret')
  })

  it('ignores a delayed load-more response from the previous agent audience', async () => {
    const loadMore = deferred<{ credentials: typeof credential[]; nextCursor: string | null }>()
    apiMocks.list.mockReset()
    apiMocks.list
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Old first page' })], nextCursor: 'next' })
      .mockReturnValueOnce(loadMore.promise)
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Current first page' })], nextCursor: null })

    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="mcp" />)
    })
    await act(async () => {
      findButton('Load more', container)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })
    await act(async () => {
      loadMore.resolve({ credentials: [makeCredential({ id: 'credential-2', label: 'Stale next page' })], nextCursor: null })
    })

    expect(container.textContent).not.toContain('Stale next page')
    expect(container.textContent).toContain('Current first page')
  })

  it('ignores a delayed rotate response from the previous agent audience', async () => {
    const rotate = deferred<{ credential: typeof credential; secret: string }>()
    apiMocks.list.mockReset()
    apiMocks.list
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Old credential' })], nextCursor: null })
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Current credential' })], nextCursor: null })
    apiMocks.rotate.mockReturnValue(rotate.promise)

    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="mcp" />)
    })
    await act(async () => {
      findButton('Rotate', container)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      findButton('Rotate credential', document.body)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })
    await act(async () => {
      rotate.resolve({ credential: makeCredential({ label: 'Stale rotated credential' }), secret: 'stale-rotate-secret' })
    })

    expect(container.textContent).toContain('Current credential')
    expect(container.textContent).not.toContain('Stale rotated credential')
    expect(container.textContent).not.toContain('Shown once')
  })

  it('ignores a delayed revoke response from the previous agent audience', async () => {
    const revoke = deferred<void>()
    apiMocks.list.mockReset()
    apiMocks.list
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Old credential' })], nextCursor: null })
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Current credential' })], nextCursor: null })
    apiMocks.revoke.mockReturnValue(revoke.promise)

    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="mcp" />)
    })
    await act(async () => {
      findButton('Revoke', container)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      findButton('Revoke credential', document.body)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })
    await act(async () => {
      revoke.resolve()
    })

    expect(container.textContent).toContain('Current credential')
    expect(container.textContent).toContain('active')
    expect(container.textContent).not.toContain('revoked')
  })
})
