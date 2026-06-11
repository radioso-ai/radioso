import { describe, expect, it } from 'vitest'

import type { ConversationTrace, TurnTraceEnvelope } from '@/lib/api'
import {
  getPrimaryLeaf,
  getPrimaryLeafTrace,
  resolveCapabilityLeaf,
  spineStageLabel,
  stageLeafView,
} from '@/lib/turn-trace'

const activityTrace = { traceId: 'trace-1', startedAt: '2026-01-01T00:00:00.000Z', stages: [], links: [] }

const spine = (): ConversationTrace => ({
  traceId: 'conversation-turn-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  stages: [
    { id: 'gather', kind: 'gather', status: 'applied' },
    { id: 'directives', kind: 'directive_match', status: 'skipped' },
    { id: 'selection', kind: 'skill_selection', status: 'applied' },
    {
      id: 'dispatch:retrieval.answer',
      kind: 'skill_dispatch',
      status: 'applied',
      subTrace: { namespace: 'retrieval', version: 1, payload: activityTrace },
    },
    { id: 'compose', kind: 'compose', status: 'applied' },
  ],
})

describe('spineStageLabel', () => {
  it('maps known spine kinds to friendly labels and humanizes unknowns', () => {
    expect(spineStageLabel({ id: 'g', kind: 'gather', status: 'applied' })).toBe('Gather')
    expect(spineStageLabel({ id: 'd', kind: 'skill_dispatch', status: 'applied' })).toBe('Dispatch')
    expect(spineStageLabel({ id: 'c', kind: 'clarification', status: 'applied' })).toBe('Clarification')
    expect(spineStageLabel({ id: 'x', kind: 'custom_phase', status: 'applied' })).toBe('custom phase')
  })
})

describe('resolveCapabilityLeaf', () => {
  it('resolves retrieval and skill-intake namespaces to the activity-trace view', () => {
    expect(resolveCapabilityLeaf({ namespace: 'retrieval', version: 1, payload: activityTrace }).kind)
      .toBe('activity-trace')
    expect(resolveCapabilityLeaf({ namespace: 'skill-intake', version: 1, payload: activityTrace }).kind)
      .toBe('activity-trace')
  })

  it('falls back to a raw view for unknown namespaces', () => {
    const leaf = resolveCapabilityLeaf({ namespace: 'routine', version: 1, payload: { step: 2 } })
    expect(leaf.kind).toBe('raw')
    expect(leaf).toMatchObject({ namespace: 'routine', payload: { step: 2 } })
  })
})

describe('stageLeafView / getPrimaryLeaf', () => {
  it('returns undefined for spine stages without a sub-trace', () => {
    expect(stageLeafView({ id: 'gather', kind: 'gather', status: 'applied' })).toBeUndefined()
  })

  it('finds the first dispatch stage carrying an activity-trace leaf', () => {
    const primary = getPrimaryLeaf(spine())
    expect(primary?.stageId).toBe('dispatch:retrieval.answer')
    expect(primary?.trace.traceId).toBe('trace-1')
  })

  it('derives the primary leaf trace straight from an envelope', () => {
    const envelope: TurnTraceEnvelope = { version: 1, spine: spine() }
    expect(getPrimaryLeafTrace(envelope)?.traceId).toBe('trace-1')
    expect(getPrimaryLeafTrace(undefined)).toBeUndefined()
  })
})
