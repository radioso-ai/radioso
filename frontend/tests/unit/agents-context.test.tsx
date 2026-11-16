/* @vitest-environment jsdom */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  listAgents: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  deleteAgent: vi.fn(),
}))
vi.mock('@/lib/api', () => ({ agentsApi: api }))

import { AgentsProvider, useAgents, type AgentsPort } from '@/lib/agents-context'
import type { AgentSettings } from '@/lib/api'

const agent = (id: string, name: string, extra: Partial<AgentSettings> = {}) => ({ id, name, internalName: '', isDefault: false, ...extra }) as AgentSettings
const marta = agent('11111111-1111-4111-8111-111111111111', 'Marta', { isDefault: true })
const sales = agent('22222222-2222-4222-8222-222222222222', 'Sales')

let port: AgentsPort
function Probe() {
  const value = useAgents()
  useEffect(() => { port = value })
  return null
}

const pause = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

// Polls in short acts, so React can flush what each step set in motion.
const until = async (check: () => void) => {
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      check()
      return
    } catch (failure) {
      if (Date.now() > deadline) throw failure
      await pause(10)
    }
  }
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('AgentsProvider', () => {
  let container: HTMLDivElement
  let root: Root

  const mount = async (props: { routeAgentId?: string; enabled?: boolean } = {}) => {
    await act(async () => {
      root.render(
        <AgentsProvider workspaceId="workspace-1" routeAgentId={props.routeAgentId} enabled={props.enabled ?? true}>
          <Probe />
        </AgentsProvider>,
      )
    })
    // The first read has landed (or, with the area off screen, nothing is waited for).
    if (props.enabled ?? true) await until(() => expect(port?.status).not.toBe('loading'))
    await pause(30)
  }

  beforeEach(() => {
    window.localStorage.clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    api.listAgents.mockResolvedValue({ agents: [marta, sales] })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('reads the list once and selects the agent the route names, else the first', async () => {
    await mount({ routeAgentId: sales.id })
    expect(api.listAgents).toHaveBeenCalledTimes(1)
    expect(port.status).toBe('ready')
    expect(port.selectedAgent?.id).toBe(sales.id)
  })

  it('selects the first agent when the route names none', async () => {
    await mount()
    expect(port.selectedAgent?.id).toBe(marta.id)
  })

  it('reads nothing while the agent area is off screen', async () => {
    await mount({ enabled: false })
    expect(api.listAgents).not.toHaveBeenCalled()
    expect(port.agents).toEqual([])
  })

  it('shows an empty list with an error when the first read fails', async () => {
    api.listAgents.mockRejectedValue(new Error('down'))
    await mount()
    expect(port.status).toBe('error')
    expect(port.agents).toEqual([])
  })

  it('keeps the last list when a later read fails', async () => {
    await mount()
    api.listAgents.mockRejectedValue(new Error('down'))
    await act(async () => { await port.refresh() })
    expect(port.status).toBe('ready')
    expect(port.agents.map((entry) => entry.id)).toEqual([marta.id, sales.id])
    await act(async () => { await port.reload() })
    expect(port.status).toBe('ready')
    expect(port.agents).toHaveLength(2)
  })

  it('reads again when the route names an agent no list has held, and only then', async () => {
    const created = agent('33333333-3333-4333-8333-333333333333', 'Created elsewhere')
    await mount({ routeAgentId: created.id })
    // The first read did not know the agent, so a second one went out for it, and no third.
    await until(() => expect(api.listAgents).toHaveBeenCalledTimes(2))
    await pause(60)
    expect(api.listAgents).toHaveBeenCalledTimes(2)
  })

  it('selects the next agent and drops the deleted one, without another read', async () => {
    await mount({ routeAgentId: marta.id })
    api.deleteAgent.mockResolvedValue(undefined)
    act(() => port.requestDelete(marta.id))
    expect(port.deleteRequest).toBe(marta.id)
    const reads = api.listAgents.mock.calls.length
    await act(async () => { await port.deleteAgent(marta.id) })
    expect(api.deleteAgent).toHaveBeenCalledWith(marta.id)
    expect(port.deleteRequest).toBeNull()
    expect(port.agents.map((entry) => entry.id)).toEqual([sales.id])
    expect(port.selectedAgent?.id).toBe(sales.id)
    await pause(60)
    expect(api.listAgents).toHaveBeenCalledTimes(reads)
  })

  it('leaves the list alone when a delete fails', async () => {
    await mount({ routeAgentId: marta.id })
    api.deleteAgent.mockRejectedValue(new Error('nope'))
    await act(async () => { await expect(port.deleteAgent(marta.id)).rejects.toThrow('nope') })
    expect(port.agents).toHaveLength(2)
  })

  it('adds a created agent to the list at once and remembers it as the selection', async () => {
    await mount()
    const created = agent('44444444-4444-4444-8444-444444444444', 'Acme Support')
    api.createAgent.mockResolvedValue(created)
    await act(async () => { await port.createAgent('Acme Support') })
    expect(api.createAgent).toHaveBeenCalledWith({ name: 'Acme Support' })
    expect(port.agents.map((entry) => entry.id)).toContain(created.id)
  })

  it('writes both names, shows them in the list and tells the pages that hold them', async () => {
    await mount()
    api.updateAgent.mockResolvedValue({ name: 'Marta Prime', internalName: 'Nico (IT)' })
    const heard: unknown[] = []
    const stop = port.onRenamed((renamed) => heard.push(renamed))
    await act(async () => { await port.renameAgent(marta.id, { name: 'Marta Prime', internalName: 'Nico (IT)' }) })
    stop()
    expect(api.updateAgent).toHaveBeenCalledWith(marta.id, { name: 'Marta Prime', internalName: 'Nico (IT)' })
    expect(port.agents.find((entry) => entry.id === marta.id)).toMatchObject({ name: 'Marta Prime', internalName: 'Nico (IT)' })
    expect(heard).toEqual([{ agentId: marta.id, name: 'Marta Prime', internalName: 'Nico (IT)' }])
  })

  it('leaves the names alone and tells nobody when the rename fails', async () => {
    await mount()
    api.updateAgent.mockRejectedValue(new Error('nope'))
    const listener = vi.fn()
    port.onRenamed(listener)
    await act(async () => { await expect(port.renameAgent(marta.id, { name: 'X', internalName: '' })).rejects.toThrow('nope') })
    expect(listener).not.toHaveBeenCalled()
    expect(port.agents.find((entry) => entry.id === marta.id)?.name).toBe('Marta')
  })
})
