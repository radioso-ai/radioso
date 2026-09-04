import { describe, expect, it } from 'vitest'

import {
  agentBundleFileName,
  groupUnresolvedByElement,
  readAgentBundle,
  unresolvedElementLabel,
} from '@/lib/agent-bundle'

const bundleText = (over: Record<string, unknown> = {}) => JSON.stringify({
  bundleVersion: 1,
  agent: {
    schemaVersion: 3,
    name: 'Procurement Bot',
    authoredDirectives: [{ name: 'tone' }, { name: 'scope' }],
  },
  routines: [{ name: 'book-a-demo', version: 2, definition: {} }],
  contextVariables: [{ variableName: 'plan_tier' }],
  agentSkills: [{ name: 'crm.lookup', capability: 'webhook_call' }],
  ...over,
})

describe('readAgentBundle', () => {
  it('summarises what an operator is about to create', () => {
    const result = readAgentBundle(bundleText())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toEqual({
      agentName: 'Procurement Bot',
      bundleVersion: 1,
      directiveCount: 2,
      routineCount: 1,
      skillCount: 1,
      contextVariableCount: 1,
    })
  })

  it('rejects a file that is not JSON', () => {
    const result = readAgentBundle('not json at all')
    expect(result).toEqual({ ok: false, reason: 'That file is not valid JSON.' })
  })

  it('rejects valid JSON that is not a bundle', () => {
    const result = readAgentBundle(JSON.stringify({ hello: 'world' }))
    expect(result).toEqual({ ok: false, reason: 'That file is not an agent bundle.' })
  })

  it('names the version mismatch rather than failing at the server', () => {
    const result = readAgentBundle(bundleText({ bundleVersion: 4 }))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('version 4')
    expect(result.reason).toContain('version 1')
  })

  it('counts a bundle whose collections are absent as empty, not broken', () => {
    const result = readAgentBundle(JSON.stringify({
      bundleVersion: 1,
      agent: { schemaVersion: 3, name: 'Bare' },
    }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toMatchObject({
      agentName: 'Bare',
      routineCount: 0,
      skillCount: 0,
      contextVariableCount: 0,
      directiveCount: 0,
    })
  })
})

describe('agentBundleFileName', () => {
  it('builds a filename an operator can find again', () => {
    expect(agentBundleFileName('Procurement Bot', new Date('2026-09-04T10:00:00Z')))
      .toBe('procurement-bot-2026-09-04.json')
  })

  it('cannot produce a path segment or a hidden file from a hostile name', () => {
    const name = agentBundleFileName('../../etc/passwd', new Date('2026-09-04T10:00:00Z'))

    expect(name).toBe('etc-passwd-2026-09-04.json')
    expect(name).not.toContain('/')
    expect(name.startsWith('.')).toBe(false)
  })

  it('falls back when a name has no filename-safe characters left', () => {
    expect(agentBundleFileName('☂☂☂', new Date('2026-09-04T10:00:00Z')))
      .toBe('agent-2026-09-04.json')
  })
})

describe('groupUnresolvedByElement', () => {
  it('collects every reason for one element together', () => {
    const grouped = groupUnresolvedByElement([
      { kind: 'skill_target_unbound', element: 'skill:crm.lookup', detail: 'Bind it.' },
      { kind: 'skill_config_not_portable', element: 'skill:crm.lookup', detail: 'Re-enter them.' },
      { kind: 'context_variable_missing', element: 'contextVariable:plan_tier', detail: 'Create it.' },
    ])

    expect(grouped).toHaveLength(2)
    expect(grouped[0].element).toBe('skill:crm.lookup')
    expect(grouped[0].entries).toHaveLength(2)
    expect(grouped[1].entries).toHaveLength(1)
  })

  it('preserves the order the backend reported', () => {
    const grouped = groupUnresolvedByElement([
      { kind: 'asset_not_portable', element: 'logo:a.png', detail: '' },
      { kind: 'skill_target_unbound', element: 'skill:b', detail: '' },
    ])

    expect(grouped.map((group) => group.element)).toEqual(['logo:a.png', 'skill:b'])
  })
})

describe('unresolvedElementLabel', () => {
  it('drops the type prefix the backend uses to namespace elements', () => {
    expect(unresolvedElementLabel('skill:crm.lookup')).toBe('crm.lookup')
    expect(unresolvedElementLabel('contextVariable:plan_tier')).toBe('plan_tier')
    expect(unresolvedElementLabel('sourceScope')).toBe('sourceScope')
  })
})
