/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'

const updateAgent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ agentsApi: { updateAgent } }))

import { AGENT_RENAMED_EVENT, agentRenameField, agentRenameInitialValue, renameAgent, type AgentRenamedDetail } from '@/lib/agent-rename'

afterEach(() => vi.clearAllMocks())

describe('agent rename', () => {
  it('renames the field the agent menu shows: the internal name when set, else the visitor-facing name', () => {
    expect(agentRenameField({ name: 'Marta', internalName: 'Nico (IT)' })).toBe('internalName')
    expect(agentRenameField({ name: 'Marta', internalName: '  ' })).toBe('name')
    expect(agentRenameField({ name: 'Marta', internalName: null })).toBe('name')
    expect(agentRenameInitialValue({ name: 'Marta', internalName: 'Nico (IT)' })).toBe('Nico (IT)')
    expect(agentRenameInitialValue({ name: 'Marta' })).toBe('Marta')
  })

  it('writes only that field and announces the new name to views that are open', async () => {
    updateAgent.mockResolvedValue({})
    const announced: AgentRenamedDetail[] = []
    const listen = (event: Event) => announced.push((event as CustomEvent<AgentRenamedDetail>).detail)
    window.addEventListener(AGENT_RENAMED_EVENT, listen)
    try {
      await renameAgent('agent-1', { name: 'Marta', internalName: 'Nico (IT)' }, '  Nico (Sales) ')
    } finally {
      window.removeEventListener(AGENT_RENAMED_EVENT, listen)
    }
    expect(updateAgent).toHaveBeenCalledWith('agent-1', { internalName: 'Nico (Sales)' })
    expect(announced).toEqual([{ agentId: 'agent-1', field: 'internalName', value: 'Nico (Sales)' }])
  })

  it('announces nothing when the write fails', async () => {
    updateAgent.mockRejectedValue(new Error('nope'))
    const listen = vi.fn()
    window.addEventListener(AGENT_RENAMED_EVENT, listen)
    try {
      await expect(renameAgent('agent-1', { name: 'Marta' }, 'Marta B')).rejects.toThrow('nope')
    } finally {
      window.removeEventListener(AGENT_RENAMED_EVENT, listen)
    }
    expect(listen).not.toHaveBeenCalled()
  })
})
