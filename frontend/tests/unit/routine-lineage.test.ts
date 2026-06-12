import { describe, expect, it } from 'vitest'

import type { RoutineDefinition } from '@/lib/api'
import { getRoutineLineageVersions, groupRoutineLineages } from '@/lib/routine-lineage'

const routine = (input: Partial<RoutineDefinition> & Pick<RoutineDefinition, 'id' | 'lineageId' | 'status' | 'version'>): RoutineDefinition => ({
  id: input.id,
  lineageId: input.lineageId,
  agentId: input.agentId ?? 'agent-1',
  name: input.name ?? 'Collect intake',
  version: input.version,
  status: input.status,
  createdAt: input.createdAt ?? `2026-06-12T10:0${input.version}:00.000Z`,
  updatedAt: input.updatedAt ?? `2026-06-12T10:0${input.version}:30.000Z`,
  activation: input.activation ?? {
    triggerDescription: 'Visitor asks for pricing.',
    gateRef: null,
    priority: 10,
  },
  slots: input.slots ?? [],
  steps: input.steps ?? [],
  transitions: input.transitions ?? [],
  terminals: input.terminals ?? [],
  completionExport: input.completionExport,
})

describe('groupRoutineLineages', () => {
  it('groups versions by lineageId and chooses the published version as active', () => {
    const grouped = groupRoutineLineages([
      routine({ id: 'draft-2', lineageId: 'lineage-a', status: 'draft', version: 2 }),
      routine({ id: 'published-1', lineageId: 'lineage-a', status: 'published', version: 1 }),
      routine({ id: 'other-draft', lineageId: 'lineage-b', status: 'draft', version: 1, name: 'Order help' }),
    ])

    expect(grouped.archived).toEqual([])
    expect(grouped.active).toHaveLength(2)
    expect(grouped.active[0]).toMatchObject({
      lineageId: 'lineage-a',
      state: 'published',
      activeRoutine: expect.objectContaining({ id: 'published-1' }),
      pendingDraft: expect.objectContaining({ id: 'draft-2' }),
      displayRoutine: expect.objectContaining({ id: 'published-1' }),
    })
    expect(grouped.active[1]).toMatchObject({
      lineageId: 'lineage-b',
      state: 'draft-only',
      activeRoutine: null,
      pendingDraft: null,
      displayRoutine: expect.objectContaining({ id: 'other-draft' }),
    })
  })

  it('partitions archived lineages out of the active list', () => {
    const grouped = groupRoutineLineages([
      routine({ id: 'archived-2', lineageId: 'lineage-a', status: 'archived', version: 2 }),
      routine({ id: 'superseded-1', lineageId: 'lineage-a', status: 'superseded', version: 1 }),
      routine({ id: 'published-1', lineageId: 'lineage-b', status: 'published', version: 1, name: 'Order help' }),
    ])

    expect(grouped.active.map((group) => group.lineageId)).toEqual(['lineage-b'])
    expect(grouped.archived).toHaveLength(1)
    expect(grouped.archived[0]).toMatchObject({
      lineageId: 'lineage-a',
      state: 'archived',
      activeRoutine: expect.objectContaining({ id: 'archived-2' }),
      pendingDraft: null,
    })
  })

  it('keeps a draft with archived history in the active list while preserving restore history', () => {
    const grouped = groupRoutineLineages([
      routine({ id: 'archived-1', lineageId: 'lineage-a', status: 'archived', version: 1 }),
      routine({ id: 'draft-2', lineageId: 'lineage-a', status: 'draft', version: 2 }),
    ])

    expect(grouped.archived).toEqual([])
    expect(grouped.active).toHaveLength(1)
    expect(grouped.active[0]).toMatchObject({
      lineageId: 'lineage-a',
      state: 'draft-with-archived',
      displayRoutine: expect.objectContaining({ id: 'draft-2' }),
      activeRoutine: expect.objectContaining({ id: 'archived-1' }),
      pendingDraft: null,
    })
    expect(grouped.active[0]!.versions.map((version) => version.id)).toEqual(['draft-2', 'archived-1'])
  })

  it('sorts version history newest first with drafts before same-version history rows', () => {
    const versions = getRoutineLineageVersions([
      routine({ id: 'v1', lineageId: 'lineage-a', status: 'superseded', version: 1 }),
      routine({ id: 'draft-v3', lineageId: 'lineage-a', status: 'draft', version: 3 }),
      routine({ id: 'v2', lineageId: 'lineage-a', status: 'published', version: 2 }),
      routine({ id: 'other', lineageId: 'lineage-b', status: 'published', version: 4 }),
    ], 'lineage-a')

    expect(versions.map((version) => version.id)).toEqual(['draft-v3', 'v2', 'v1'])
  })
})
