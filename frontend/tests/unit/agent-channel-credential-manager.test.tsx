/* @vitest-environment jsdom */

import { act, useEffect } from 'react'
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
import {
  useAgentChannelCredentials,
  type AgentChannelCredentialEngine,
} from '@/hooks/use-agent-channel-credentials'
import type { AgentChannelCredential, AgentChannelCredentialAudience } from '@/lib/api-agent-channel-credentials'

const credential: AgentChannelCredential = {
  id: 'credential-1', audience: 'mcp', label: 'Desktop', prefix: 'rdso_abc', status: 'active',
  createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z', lastUsedAt: null, revokedAt: null,
}

const makeCredential = (overrides: Partial<AgentChannelCredential> = {}): AgentChannelCredential => ({ ...credential, ...overrides })

type CredentialPage = { credentials: AgentChannelCredential[]; nextCursor: string | null }
type IssuedCredential = { credential: AgentChannelCredential; secret: string }

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

let engine: AgentChannelCredentialEngine

function EngineHarness({ agentId, audience }: { agentId: string; audience: AgentChannelCredentialAudience }) {
  const value = useAgentChannelCredentials(agentId, audience)
  useEffect(() => {
    engine = value
  })
  return null
}

const findButton = (text: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll('button')).find((button) => button.textContent?.includes(text))

const fillLabel = (root: ParentNode, value: string) => {
  const input = root.querySelector<HTMLInputElement>('#rest-credential-label')
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, value)
  input?.dispatchEvent(new Event('input', { bubbles: true }))
  input?.dispatchEvent(new Event('change', { bubbles: true }))
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('useAgentChannelCredentials', () => {
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

  const render = (agentId: string, audience: AgentChannelCredentialAudience) =>
    act(async () => {
      root.render(<EngineHarness agentId={agentId} audience={audience} />)
    })

  it('drops the issued secret and prior inventory when the audience changes', async () => {
    apiMocks.list.mockResolvedValue({ credentials: [makeCredential({ label: 'Existing' })], nextCursor: null })
    await render('agent-1', 'mcp')
    await act(async () => {
      await engine.issue({ label: 'Desktop', expiresAt: '2027-01-01T00:00:00.000Z' })
    })
    expect(engine.issued?.secret).toBe('one-time-secret')

    await render('agent-1', 'rest')

    expect(engine.issued).toBeNull()
    expect(engine.credentials.map((entry) => entry.label)).toEqual(['Existing'])
  })

  it('ignores a delayed inventory response from the previous audience', async () => {
    const oldList = deferred<CredentialPage>()
    const newList = deferred<CredentialPage>()
    apiMocks.list.mockReset()
    apiMocks.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise)

    await render('agent-1', 'mcp')
    await render('agent-1', 'rest')

    await act(async () => {
      oldList.resolve({ credentials: [makeCredential({ label: 'Old audience' })], nextCursor: null })
    })
    expect(engine.credentials).toEqual([])

    await act(async () => {
      newList.resolve({ credentials: [makeCredential({ label: 'Current audience' })], nextCursor: null })
    })
    expect(engine.credentials.map((entry) => entry.label)).toEqual(['Current audience'])
  })

  it('ignores a delayed inventory response from the previous agent', async () => {
    const oldList = deferred<CredentialPage>()
    const newList = deferred<CredentialPage>()
    apiMocks.list.mockReset()
    apiMocks.list.mockReturnValueOnce(oldList.promise).mockReturnValueOnce(newList.promise)

    await render('agent-old', 'mcp')
    await render('agent-current', 'mcp')

    await act(async () => {
      oldList.resolve({ credentials: [makeCredential({ label: 'Old agent' })], nextCursor: null })
    })
    expect(engine.credentials).toEqual([])

    await act(async () => {
      newList.resolve({ credentials: [makeCredential({ label: 'Current agent' })], nextCursor: null })
    })
    expect(engine.credentials.map((entry) => entry.label)).toEqual(['Current agent'])
  })

  it('ignores a delayed issue response from the previous audience', async () => {
    const issue = deferred<IssuedCredential>()
    apiMocks.issue.mockReturnValue(issue.promise)

    await render('agent-1', 'mcp')
    let issuePromise: Promise<boolean> | undefined
    await act(async () => {
      issuePromise = engine.issue({ label: 'Old audience', expiresAt: '2027-01-01T00:00:00.000Z' })
    })

    await render('agent-1', 'rest')
    await act(async () => {
      issue.resolve({ credential: makeCredential({ label: 'Old issued credential' }), secret: 'old-secret' })
      await issuePromise
    })

    expect(engine.issued).toBeNull()
    expect(engine.credentials).toEqual([])
  })

  it('ignores a delayed load-more response from the previous audience', async () => {
    const loadMore = deferred<CredentialPage>()
    apiMocks.list.mockReset()
    apiMocks.list
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Old first page' })], nextCursor: 'next' })
      .mockReturnValueOnce(loadMore.promise)
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Current first page' })], nextCursor: null })

    await render('agent-1', 'mcp')
    let loadMorePromise: Promise<void> | undefined
    await act(async () => {
      loadMorePromise = engine.loadMore()
    })
    await render('agent-1', 'rest')
    await act(async () => {
      loadMore.resolve({ credentials: [makeCredential({ id: 'credential-2', label: 'Stale next page' })], nextCursor: null })
      await loadMorePromise
    })

    expect(engine.credentials.map((entry) => entry.label)).toEqual(['Current first page'])
  })

  it('ignores a delayed rotate response from the previous agent', async () => {
    const rotate = deferred<IssuedCredential>()
    apiMocks.list.mockReset()
    apiMocks.list
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Old credential' })], nextCursor: null })
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Current credential' })], nextCursor: null })
    apiMocks.rotate.mockReturnValue(rotate.promise)

    await render('agent-old', 'mcp')
    let rotatePromise: Promise<boolean> | undefined
    await act(async () => {
      rotatePromise = engine.rotate('credential-1')
    })
    await render('agent-current', 'mcp')
    await act(async () => {
      rotate.resolve({ credential: makeCredential({ label: 'Stale rotated credential' }), secret: 'stale-rotate-secret' })
      await rotatePromise
    })

    expect(engine.issued).toBeNull()
    expect(engine.credentials.map((entry) => entry.label)).toEqual(['Current credential'])
  })

  it('ignores a delayed revoke response from the previous audience', async () => {
    const revoke = deferred<void>()
    apiMocks.list.mockReset()
    apiMocks.list
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Old credential' })], nextCursor: null })
      .mockResolvedValueOnce({ credentials: [makeCredential({ label: 'Current credential' })], nextCursor: null })
    apiMocks.revoke.mockReturnValue(revoke.promise)

    await render('agent-1', 'mcp')
    let revokePromise: Promise<boolean> | undefined
    await act(async () => {
      revokePromise = engine.revoke('credential-1')
    })
    await render('agent-1', 'rest')
    await act(async () => {
      revoke.resolve()
      await revokePromise
    })

    expect(engine.credentials.map((entry) => entry.status)).toEqual(['active'])
  })

  it('marks a revoked credential without dropping it from the inventory', async () => {
    apiMocks.list.mockResolvedValue({ credentials: [makeCredential({ label: 'Current credential' })], nextCursor: null })
    apiMocks.revoke.mockResolvedValue(undefined)

    await render('agent-1', 'mcp')
    await act(async () => {
      await engine.revoke('credential-1')
    })

    expect(engine.credentials.map((entry) => entry.status)).toEqual(['revoked'])
    expect(engine.credentials[0]?.revokedAt).toBeTruthy()
  })
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
    apiMocks.revoke.mockResolvedValue(undefined)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const create = async (label: string) => {
    fillLabel(container, label)
    await act(async () => {
      findButton('Create credential', container)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('requires acknowledgement before the issued secret can be dismissed', async () => {
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })
    await create('Production chat client')

    expect(document.body.textContent).toContain('one-time-secret')
    const done = findButton('Done', document.body) as HTMLButtonElement
    expect(done.disabled).toBe(true)

    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]')
    await act(async () => {
      checkbox!.click()
    })
    expect((findButton('Done', document.body) as HTMLButtonElement).disabled).toBe(false)

    await act(async () => {
      findButton('Done', document.body)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(document.body.textContent).not.toContain('one-time-secret')
  })

  it('revokes the freshly issued credential when the operator discards it', async () => {
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })
    await create('Production chat client')

    await act(async () => {
      findButton('Discard', document.body)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(apiMocks.revoke).toHaveBeenCalledWith('agent-1', 'credential-1')
    expect(document.body.textContent).not.toContain('one-time-secret')
  })

  it('sends the trimmed label and an expiry instant to the issue endpoint', async () => {
    await act(async () => {
      root.render(<AgentChannelCredentialManager agentId="agent-1" audience="rest" />)
    })
    await create('  Production chat client  ')

    expect(apiMocks.issue).toHaveBeenCalledWith('agent-1', expect.objectContaining({
      audience: 'rest',
      label: 'Production chat client',
    }))
    const [, payload] = apiMocks.issue.mock.calls[0] as [string, { expiresAt: string }]
    expect(new Date(payload.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })
})
