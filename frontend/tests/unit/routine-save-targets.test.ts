import { describe, expect, it } from 'vitest'

import type { AgentContextVariableEnablement, ContextVariable } from '@/lib/api-types'
import { routineSaveTargetsFromEnablements, saveTargetsForField } from '@/lib/routine-save-targets'

const enablement = (
  name: string,
  overrides: { source?: AgentContextVariableEnablement['source']; enabled?: boolean; variable?: Partial<ContextVariable> } = {},
): AgentContextVariableEnablement => ({
  id: `en_${name}`,
  agentId: 'agent_1',
  variableId: `var_${name}`,
  source: overrides.source ?? 'pushed',
  resolverSkillId: null,
  maxAgeSeconds: null,
  resolverTimeoutMs: null,
  surfacing: 'on_reference',
  enabled: overrides.enabled ?? true,
  createdAt: '2026-11-24T00:00:00.000Z',
  updatedAt: '2026-11-24T00:00:00.000Z',
  variable: {
    id: `var_${name}`,
    workspaceId: 'ws_1',
    name,
    description: null,
    valueType: 'string',
    options: null,
    trustTier: 'unverified',
    sensitivity: 'normal',
    defaultSurfacing: 'on_reference',
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
    ...overrides.variable,
  },
})

describe('routineSaveTargetsFromEnablements', () => {
  it('offers the enabled pushed attributes, never a proof or one the AI picks', () => {
    const targets = routineSaveTargetsFromEnablements([
      enablement('party_size', { variable: { valueType: 'number' } }),
      enablement('topic', { source: 'classified', variable: { valueType: 'enum' } }),
      enablement('plan', { variable: { trustTier: 'signed' } }),
      enablement('page', { source: 'browser' }),
      enablement('crm_tier', { source: 'resolver' }),
      enablement('parked', { enabled: false }),
      enablement('health_note', { variable: { sensitivity: 'sensitive' } }),
    ])

    expect(targets).toEqual([
      { name: 'party_size', valueType: 'number', private: false },
      { name: 'health_note', valueType: 'string', private: true },
    ])
  })
})

describe('saveTargetsForField', () => {
  const targets = routineSaveTargetsFromEnablements([
    enablement('party_size', { variable: { valueType: 'number' } }),
    enablement('contact_email'),
    enablement('health_note', { variable: { sensitivity: 'sensitive' } }),
    enablement('arrival', { variable: { valueType: 'date' } }),
  ])

  it('lists the attributes of a type the field saves to', () => {
    expect(saveTargetsForField(targets, { type: 'number' }).map((target) => target.name)).toEqual(['party_size'])
    expect(saveTargetsForField(targets, { type: 'email' }).map((target) => target.name)).toEqual(['contact_email', 'health_note'])
    expect(saveTargetsForField(targets, { type: 'date' }).map((target) => target.name)).toEqual(['arrival'])
    expect(saveTargetsForField(targets, { type: 'item' })).toEqual([])
  })

  it('lists only Private attributes for a sensitive field', () => {
    expect(saveTargetsForField(targets, { type: 'text', sensitivity: 'sensitive' }).map((target) => target.name)).toEqual(['health_note'])
  })
})
