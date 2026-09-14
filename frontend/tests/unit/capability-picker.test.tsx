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

  it('renders a real link to the MCP connection setup instead of dead text', async () => {
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

    const link = [...document.querySelectorAll('a')].find((anchor) => anchor.textContent === 'Connections')
    expect(link).toBeTruthy()
    expect(link?.getAttribute('href')).toBe(
      '/account/account-1/agents/agent-1?tab=channels&anchor=mcp-channel',
    )
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
})
