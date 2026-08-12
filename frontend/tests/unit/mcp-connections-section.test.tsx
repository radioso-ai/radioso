/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  deleteConnection: vi.fn(),
  startOauth: vi.fn(),
}))

vi.mock('@/lib/api-external-skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-external-skills')>()),
  externalSkillsApi: apiMocks,
}))

import { McpConnectionsSection } from '@/components/dashboard/settings/skills/McpConnectionsSection'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const connection = (id: string, displayName: string) => ({
  id,
  displayName,
  serverUrl: `https://${id}.example.test/mcp`,
  authMethod: 'access_token',
  status: 'authorized',
  hasCredential: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

describe('McpConnectionsSection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    vi.clearAllMocks()
  })

  it('discards an older agent load that completes after the active agent load', async () => {
    const firstConnections = deferred<{ connections: ReturnType<typeof connection>[] }>()
    apiMocks.listConnections.mockImplementation((agentId: string) =>
      agentId === 'agent-1'
        ? firstConnections.promise
        : Promise.resolve({ connections: [connection('connection-2', 'Second connection')] }),
    )

    await act(async () => {
      root.render(<McpConnectionsSection agentId="agent-1" />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await act(async () => {
      root.render(<McpConnectionsSection agentId="agent-2" />)
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.textContent).toContain('Second connection')

    await act(async () => {
      firstConnections.resolve({ connections: [connection('connection-1', 'First connection')] })
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Second connection')
    expect(container.textContent).not.toContain('First connection')
  })
})
