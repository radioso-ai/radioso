/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  deleteConnection: vi.fn(),
  updateConnection: vi.fn(),
  startOauth: vi.fn(),
  discoverTools: vi.fn(),
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

  it('discards a connection test result when the active agent changes', async () => {
    const testResult = deferred<{ tools: { name: string }[] }>()
    apiMocks.listConnections.mockImplementation((agentId: string) => Promise.resolve({
      connections: [connection('shared-id', agentId)],
    }))
    apiMocks.discoverTools.mockReturnValue(testResult.promise)
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Test connection to agent-1"]')!.click()
    })
    expect(apiMocks.discoverTools).toHaveBeenCalledWith('agent-1', 'shared-id')
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-2" />) })
    await act(async () => {
      testResult.resolve({ tools: [{ name: 'old-agent-tool' }] })
      await testResult.promise
    })
    expect(container.textContent).not.toContain('1 tool found')
    expect(container.textContent).not.toContain('Testing…')
  })

  it('replaces a rejected access token and reloads the connection', async () => {
    apiMocks.listConnections
      .mockResolvedValueOnce({ connections: [{ ...connection('conn-1', 'Ananda'), status: 'needs_reauth' }] })
      .mockResolvedValueOnce({ connections: [connection('conn-1', 'Ananda')] })
    apiMocks.discoverTools.mockRejectedValue(new Error('The MCP server rejected this connection\'s access token.'))
    apiMocks.updateConnection.mockResolvedValue(connection('conn-1', 'Ananda'))
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Test connection to Ananda"]')!.click()
    })
    apiMocks.listConnections.mockClear()
    expect(container.textContent).toContain('rejected this connection')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Replace token for Ananda"]')!.click()
    })
    const tokenInput = container.querySelector<HTMLInputElement>('[aria-label="New access token for Ananda"]')!
    await act(async () => { typeInto(tokenInput, 'fresh-token') })
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Save token for Ananda"]')!.click()
    })

    expect(apiMocks.updateConnection).toHaveBeenCalledWith('agent-1', 'conn-1', { accessToken: 'fresh-token' })
    expect(apiMocks.listConnections).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-label="New access token for Ananda"]')).toBeNull()
    expect(container.textContent).not.toContain('rejected this connection')
  })
})

const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
