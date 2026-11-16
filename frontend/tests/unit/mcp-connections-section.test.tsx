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
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const connection = (id: string, displayName: string) => ({
  id,
  displayName,
  serverUrl: `https://${id}.example.test/mcp`,
  authMethod: 'access_token',
  status: 'authorized',
  hasCredential: true,
  usedByAgents: [] as Array<{ id: string; name: string }>,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const rowButton = (container: HTMLElement, name: string) =>
  container.querySelector<HTMLButtonElement>(`[data-quiet-list-row-button][aria-label="${name}"]`)

const byLabel = (container: HTMLElement, label: string) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)

const click = async (element: HTMLElement | null) => {
  await act(async () => { element!.click() })
}

// The confirmation is a portal, so it is read from the document rather than the section's container.
const confirmation = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]')

const confirmationButton = (label: string) =>
  Array.from(confirmation()?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === label) ?? null

const confirmDelete = () => click(confirmationButton('Delete connection'))

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

  it('lists each connection as a quiet row and badges only the ones that need attention', async () => {
    apiMocks.listConnections.mockResolvedValue({
      connections: [
        connection('connection-1', 'Shared'),
        { ...connection('connection-2', 'Spare'), status: 'needs_reauth' },
      ],
    })

    await act(async () => {
      root.render(<McpConnectionsSection agentId="agent-1" />)
    })

    expect(rowButton(container, 'Shared')).not.toBeNull()
    expect(container.textContent).toContain('https://connection-1.example.test/mcp')
    expect(container.textContent).toContain('Needs re-auth')
    expect(container.textContent).not.toContain('Credentials saved')
    expect(byLabel(container, 'Test connection to Shared')).toBeNull()
  })

  it('names the agents whose skills use each connection in its detail view', async () => {
    apiMocks.listConnections.mockResolvedValue({
      connections: [
        { ...connection('connection-1', 'Shared'), usedByAgents: [{ id: 'agent-1', name: 'Support' }, { id: 'agent-2', name: 'Sales' }] },
        connection('connection-2', 'Spare'),
      ],
    })

    await act(async () => {
      root.render(<McpConnectionsSection agentId="agent-1" />)
    })
    await click(rowButton(container, 'Shared'))

    expect(container.textContent).toContain('Used by')
    expect(container.textContent).toContain('Support, Sales')
    expect(container.textContent).toContain('Credentials saved')

    await click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Back to connections')) ?? null)
    await click(rowButton(container, 'Spare'))

    expect(container.textContent).toContain('No skills yet')
  })

  it('returns the keyboard to the row when going back to the list', async () => {
    apiMocks.listConnections.mockResolvedValue({
      connections: [connection('connection-1', 'Shared'), connection('connection-2', 'Spare')],
    })
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Spare'))
    expect(rowButton(container, 'Spare')).toBeNull()

    await click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Back to connections')) ?? null)

    expect(document.activeElement).toBe(rowButton(container, 'Spare'))
  })

  it('returns to the list when the open connection is deleted', async () => {
    apiMocks.listConnections.mockResolvedValue({
      connections: [connection('connection-1', 'Shared'), connection('connection-2', 'Spare')],
    })
    apiMocks.deleteConnection.mockResolvedValue(undefined)
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Shared'))

    await click(byLabel(container, 'Delete Shared'))
    expect(apiMocks.deleteConnection).not.toHaveBeenCalled()

    await confirmDelete()

    expect(apiMocks.deleteConnection).toHaveBeenCalledWith('agent-1', 'connection-1')
    expect(rowButton(container, 'Shared')).toBeNull()
    expect(confirmation()).toBeNull()
    expect(document.activeElement).toBe(rowButton(container, 'Spare'))
  })

  it('asks before deleting, saying the connection is removed for every agent and who uses it', async () => {
    apiMocks.listConnections.mockResolvedValue({
      connections: [
        { ...connection('connection-1', 'Shared'), usedByAgents: [{ id: 'agent-1', name: 'Support' }, { id: 'agent-2', name: 'Sales' }] },
        connection('connection-2', 'Spare'),
      ],
    })
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Shared'))

    await click(byLabel(container, 'Delete Shared'))

    expect(confirmation()?.textContent).toContain('Delete MCP connection?')
    expect(confirmation()?.textContent).toContain('Deletes "Shared" for every agent in this workspace.')
    expect(confirmation()?.textContent).toContain('Used by Support, Sales.')

    await click(confirmationButton('Cancel'))
    await click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Back to connections')) ?? null)
    await click(rowButton(container, 'Spare'))
    await click(byLabel(container, 'Delete Spare'))

    expect(confirmation()?.textContent).not.toContain('Used by')
  })

  it('leaves the connection alone when the confirmation is cancelled', async () => {
    apiMocks.listConnections.mockResolvedValue({ connections: [connection('connection-1', 'Shared')] })
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Shared'))
    await click(byLabel(container, 'Delete Shared'))

    await click(confirmationButton('Cancel'))

    expect(apiMocks.deleteConnection).not.toHaveBeenCalled()
    expect(confirmation()).toBeNull()
    expect(byLabel(container, 'Delete Shared')).not.toBeNull()
  })

  it('keeps the confirmation open and locked while the delete runs, then shows a failure under it', async () => {
    const deletion = deferred<undefined>()
    apiMocks.listConnections.mockResolvedValue({ connections: [connection('connection-1', 'Shared')] })
    apiMocks.deleteConnection.mockReturnValue(deletion.promise)
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Shared'))
    await click(byLabel(container, 'Delete Shared'))

    await confirmDelete()

    expect(confirmation()).not.toBeNull()
    expect(confirmationButton('Cancel')!.disabled).toBe(true)
    expect(confirmationButton('Delete connection')!.disabled).toBe(true)

    await act(async () => {
      deletion.promise.catch(() => undefined)
      deletion.reject(new Error('The server refused.'))
      await deletion.promise.catch(() => undefined)
    })

    expect(confirmation()).toBeNull()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('The server refused.')
    expect(byLabel(container, 'Delete Shared')).not.toBeNull()
  })

  it('keeps another connection\'s detail open when a delete of the one left behind finishes', async () => {
    const deletion = deferred<undefined>()
    apiMocks.listConnections.mockResolvedValue({
      connections: [connection('connection-1', 'Shared'), connection('connection-2', 'Spare')],
    })
    apiMocks.deleteConnection.mockReturnValue(deletion.promise)
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Shared'))
    await click(byLabel(container, 'Delete Shared'))
    await confirmDelete()
    await click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Back to connections')) ?? null)
    await click(rowButton(container, 'Spare'))

    await act(async () => {
      deletion.resolve(undefined)
      await deletion.promise
    })

    expect(byLabel(container, 'Delete Spare')).not.toBeNull()
    expect(document.activeElement).toBe(container.querySelector('h3'))
  })

  it('clears an earlier failure when a different connection is opened', async () => {
    apiMocks.listConnections.mockResolvedValue({
      connections: [connection('connection-1', 'Shared'), connection('connection-2', 'Spare')],
    })
    apiMocks.deleteConnection.mockRejectedValue(new Error('The server refused.'))
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Shared'))
    await click(byLabel(container, 'Delete Shared'))
    await confirmDelete()
    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    await click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Back to connections')) ?? null)

    await click(rowButton(container, 'Spare'))

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps one connection\'s pending test from locking another connection\'s controls', async () => {
    const testResult = deferred<{ tools: { name: string }[] }>()
    apiMocks.listConnections.mockResolvedValue({
      connections: [connection('connection-1', 'Shared'), connection('connection-2', 'Spare')],
    })
    apiMocks.discoverTools.mockReturnValue(testResult.promise)
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Shared'))
    await click(byLabel(container, 'Test connection to Shared'))
    expect(byLabel(container, 'Test connection to Shared')!.disabled).toBe(true)

    await click(Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('Back to connections')) ?? null)
    await click(rowButton(container, 'Spare'))

    expect(byLabel(container, 'Test connection to Spare')!.disabled).toBe(false)
    expect(byLabel(container, 'Delete Spare')!.disabled).toBe(false)
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
    await click(rowButton(container, 'agent-1'))
    await click(byLabel(container, 'Test connection to agent-1'))
    expect(apiMocks.discoverTools).toHaveBeenCalledWith('agent-1', 'shared-id')
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-2" />) })
    await act(async () => {
      testResult.resolve({ tools: [{ name: 'old-agent-tool' }] })
      await testResult.promise
    })
    expect(container.textContent).not.toContain('1 tool found')
    expect(container.textContent).not.toContain('Testing…')
    // The open connection belonged to the first agent, so the second agent's panel shows its list.
    expect(rowButton(container, 'agent-2')).not.toBeNull()
  })

  it('replaces a rejected access token and reloads the connection', async () => {
    apiMocks.listConnections
      .mockResolvedValueOnce({ connections: [{ ...connection('conn-1', 'Valmora'), status: 'needs_reauth' }] })
      .mockResolvedValueOnce({ connections: [connection('conn-1', 'Valmora')] })
    apiMocks.discoverTools.mockRejectedValue(new Error('The MCP server rejected this connection\'s access token.'))
    apiMocks.updateConnection.mockResolvedValue(connection('conn-1', 'Valmora'))
    await act(async () => { root.render(<McpConnectionsSection agentId="agent-1" />) })
    await click(rowButton(container, 'Valmora'))
    await click(byLabel(container, 'Test connection to Valmora'))
    apiMocks.listConnections.mockClear()
    expect(container.textContent).toContain('rejected this connection')

    await click(byLabel(container, 'Replace token for Valmora'))
    const tokenInput = container.querySelector<HTMLInputElement>('[aria-label="New access token for Valmora"]')!
    await act(async () => { typeInto(tokenInput, 'fresh-token') })
    await click(byLabel(container, 'Save token for Valmora'))

    expect(apiMocks.updateConnection).toHaveBeenCalledWith('agent-1', 'conn-1', { accessToken: 'fresh-token' })
    expect(apiMocks.listConnections).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[aria-label="New access token for Valmora"]')).toBeNull()
    expect(container.textContent).not.toContain('rejected this connection')
  })
})

const typeInto = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
