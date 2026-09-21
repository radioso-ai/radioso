import { describe, expect, it } from 'vitest'

import type { AgentContextVariableEnablement } from '@/lib/api-types'
import { contextVariableLabel, routineContextVariablesFromEnablements } from '@/lib/routine-context-variables'

const enablement = (overrides: Partial<AgentContextVariableEnablement> & { name?: string }): AgentContextVariableEnablement => ({
  id: `en_${overrides.name ?? 'x'}`,
  agentId: 'agent_1',
  variableId: `var_${overrides.name ?? 'x'}`,
  source: 'pushed',
  resolverSkillId: null,
  maxAgeSeconds: null,
  resolverTimeoutMs: null,
  surfacing: 'on_reference',
  enabled: true,
  createdAt: '2026-09-21T00:00:00.000Z',
  updatedAt: '2026-09-21T00:00:00.000Z',
  ...(overrides.name
    ? { variable: { id: `var_${overrides.name}`, workspaceId: 'ws_1', name: overrides.name, description: null, valueType: 'json', trustTier: 'unverified', sensitivity: 'normal', defaultSurfacing: 'on_reference', createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' } }
    : {}),
  ...overrides,
})

describe('routineContextVariablesFromEnablements', () => {
  it('lists the built-in page and request variables first, then each enabled host-defined variable by name', () => {
    expect(routineContextVariablesFromEnablements([
      enablement({ name: 'cart' }),
      enablement({ name: 'account_tier' }),
    ])).toEqual([
      { name: 'page_context', label: 'Current page' },
      { name: 'visitor_request', label: 'Visitor request' },
      { name: 'cart', label: 'cart' },
      { name: 'account_tier', label: 'account_tier' },
    ])
  })

  it('skips a disabled enablement and one whose variable row is missing', () => {
    expect(routineContextVariablesFromEnablements([
      enablement({ name: 'cart', enabled: false }),
      enablement({}),
    ])).toEqual([
      { name: 'page_context', label: 'Current page' },
      { name: 'visitor_request', label: 'Visitor request' },
    ])
  })

  it('lets a host-defined variable named after a built-in take the built-in place once', () => {
    const names = routineContextVariablesFromEnablements([enablement({ name: 'page_context' })]).map((variable) => variable.name)
    expect(names).toEqual(['page_context', 'visitor_request'])
  })
})

describe('contextVariableLabel', () => {
  it('names the built-ins for people and everything else by its identifier', () => {
    expect(contextVariableLabel('page_context')).toBe('Current page')
    expect(contextVariableLabel('cart')).toBe('cart')
  })
})
