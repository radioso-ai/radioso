/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SkillCapabilityDescriptor } from '@/lib/api-skills'

const authMocks = vi.hoisted(() => ({
  useOptionalAuth: vi.fn(),
}))

vi.mock('@/lib/auth-context', () => ({
  useOptionalAuth: authMocks.useOptionalAuth,
}))

vi.mock('@/components/dashboard/settings/skills/McpServersPanel', () => ({
  McpServersPanel: ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) =>
    open ? <button onClick={() => onOpenChange(false)}>Close server management</button> : null,
}))

import { CapabilityPicker } from '@/components/dashboard/settings/skills/CapabilityPicker'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const unavailableMcpCapability: SkillCapabilityDescriptor = {
  id: 'mcp_tool',
  storedKind: 'mcp_tool',
  targetKind: 'mcp_connection',
  requiresTarget: true,
  inputSchema: { source: 'discovered' },
  settingsFields: [],
  outcomeVocabulary: ['done'],
  supportedInvocationModes: ['agent_selectable'],
  defaultInvocationMode: 'agent_selectable',
  executorAdapter: 'mcp.tool',
  targets: [],
  available: false,
  unavailableReason: 'no_connection',
}

const availableRetrieveCapability: SkillCapabilityDescriptor = {
  id: 'retrieve',
  storedKind: 'retrieve',
  targetKind: 'source_scope',
  requiresTarget: false,
  inputSchema: { source: 'static', schema: { fields: [] } },
  settingsFields: [],
  outcomeVocabulary: ['found'],
  supportedInvocationModes: ['default_answer'],
  defaultInvocationMode: 'default_answer',
  executorAdapter: 'retrieval.answer',
  targets: [],
  available: true,
  unavailableReason: null,
}

describe('CapabilityPicker connection affordance', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    authMocks.useOptionalAuth.mockReturnValue({ user: { accountId: 'account-1' } })
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

  it('opens server management and refreshes capabilities on return without cancelling the picker', async () => {
    const onSelect = vi.fn()
    const onOpenChange = vi.fn()
    const onConnectionsChanged = vi.fn()
    await act(async () => {
      root.render(
        <CapabilityPicker
          open
          agentId="agent-1"
          capabilities={[unavailableMcpCapability]}
          onOpenChange={onOpenChange}
          onSelect={onSelect}
          onConnectionsChanged={onConnectionsChanged}
        />,
      )
    })

    const manageButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Manage MCP connections')
    expect(manageButton).toBeTruthy()
    await act(async () => manageButton?.click())
    expect(document.body.textContent).toContain('Close server management')
    expect(document.body.textContent).not.toContain('Add new skill')
    expect(onSelect).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()

    const closeButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Close server management')
    await act(async () => closeButton?.click())
    expect(onConnectionsChanged).toHaveBeenCalledOnce()
    expect(document.body.textContent).toContain('Add new skill')
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('does not wrap an unavailable capability card in a disabled button', async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(
        <CapabilityPicker
          open
          agentId="agent-1"
          capabilities={[unavailableMcpCapability]}
          onOpenChange={() => {}}
          onSelect={onSelect}
        />,
      )
    })

    expect(document.querySelector('button[disabled]')).toBeNull()
  })

  it('does not label an available capability "Ready"', async () => {
    const onSelect = vi.fn()
    await act(async () => {
      root.render(
        <CapabilityPicker
          open
          agentId="agent-1"
          capabilities={[availableRetrieveCapability]}
          onOpenChange={() => {}}
          onSelect={onSelect}
        />,
      )
    })

    expect(document.body.textContent).not.toContain('Ready')
  })
})
