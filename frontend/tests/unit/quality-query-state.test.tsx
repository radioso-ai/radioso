// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { qualityApi } from '@/lib/api-quality'
import {
  frozenQualityPageForKey,
  beginQualityInteraction,
  beginQualityInteractionController,
  settleQualityInteraction,
  normalizeQualityTurnsRequest,
  ownsQualityInteraction,
  patchFrozenQualityTriage,
  patchQualityTriage,
  qualityTurnsApiOptions,
  qualityTurnRemainsVisible,
  useQualityTurnsQuery,
  useQualityStatsQuery,
} from '@/lib/quality-query-state'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => vi.restoreAllMocks())

const flush = async () => { await Promise.resolve(); await Promise.resolve() }

function Probe({ enabled, workspaceId }: { enabled: boolean; workspaceId: string }) {
  useQualityTurnsQuery(workspaceId, {
    page: 2, pageSize: 25, sort: 'turn_created_at', activeNegativeFeedbackOnly: false,
    hasComment: false, hasInvalidSources: false, hasUnsourcedClaims: false, statuses: [], actions: [],
  }, enabled, 45_000)
  return null
}

function StatsProbe() {
  useQualityStatsQuery('workspace-a', { range: '7d' }, true, 45_000)
  return null
}

describe('quality query state', () => {
  it('normalizes request-equivalent defaults once and passes TanStack signal separately', async () => {
    const normalized = normalizeQualityTurnsRequest({
      page: 2, pageSize: 25, sort: 'turn_created_at', activeNegativeFeedbackOnly: false,
      hasComment: false, hasInvalidSources: false, hasUnsourcedClaims: false, statuses: [], actions: [],
    })
    expect(normalized).toMatchObject({ page: 2, pageSize: 25, sort: undefined, statuses: undefined, actions: undefined })
    expect(qualityTurnsApiOptions(normalized)).toMatchObject({ offset: 25, limit: 25 })
    expect(qualityTurnsApiOptions(normalized)).not.toHaveProperty('page')
    expect(qualityTurnsApiOptions(normalized)).not.toHaveProperty('pageSize')

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const api = vi.spyOn(qualityApi, 'listTurns').mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 25, totalPages: 0 } as never)
    const root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe, { enabled: true, workspaceId: 'workspace-a' })))
      await flush()
    })
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ offset: 25, limit: 25, sort: undefined }), expect.any(AbortSignal))
    await act(async () => { root.unmount() })
  })

  it('keeps frozen output stable while its exact cache page updates, and scopes patches to that key', () => {
    const client = new QueryClient()
    const key = ['workspace', 'workspace-a', 'quality', 'turns', null]
    const other = ['workspace', 'workspace-b', 'quality', 'turns', null]
    const page = { items: [{ assistantMessageId: 'm1', triage: { state: 'open', version: 1 } }], total: 1, page: 1, pageSize: 25, totalPages: 1 } as never
    client.setQueryData(key, page)
    client.setQueryData(other, page)
    const frozen = { queryKey: key, page }
    patchQualityTriage(client, key, 'm1', { state: 'acknowledged', version: 2, resolution: null, legacyReason: null, closedAt: null, updatedAt: null }, false)
    expect(frozenQualityPageForKey(frozen, key)).toBe(page)
    expect(client.getQueryData(key)).toMatchObject({ items: [{ triage: { state: 'acknowledged' } }] })
    expect(client.getQueryData(other)).toMatchObject({ items: [{ triage: { state: 'open' } }] })
    expect(frozenQualityPageForKey(frozen, other)).toBeNull()
  })

  it('patches only a matching frozen page so terminal conflicts can leave the rendered queue', () => {
    const key = ['workspace', 'workspace-a', 'quality', 'turns', null]
    const other = ['workspace', 'workspace-b', 'quality', 'turns', null]
    const triage = {
      state: 'resolved',
      version: 2,
      resolution: { reason: 'other', note: null },
      legacyReason: null,
      closedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: null,
    } as never
    const page = {
      items: [{ assistantMessageId: 'm1', triage: { state: 'open', version: 1 } }],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never
    const frozen = { queryKey: key, page }

    expect(patchFrozenQualityTriage(frozen, other, 'm1', triage, true)).toBe(frozen)
    expect(patchFrozenQualityTriage(frozen, key, 'm1', triage, true)).toMatchObject({
      page: { items: [], total: 0, totalPages: 0 },
    })
  })

  it('removes only an existing row, recomputes totals, and evaluates visibility from the normalized request', () => {
    const client = new QueryClient()
    const key = ['workspace', 'workspace-a', 'quality', 'turns', null]
    const triage = { state: 'resolved', version: 2, resolution: { reason: 'other', note: null }, legacyReason: null, closedAt: '2026-01-01T00:00:00.000Z', updatedAt: null } as never
    client.setQueryData(key, { items: [{ assistantMessageId: 'm1', triage }], total: 26, page: 1, pageSize: 25, totalPages: 2 })
    patchQualityTriage(client, key, 'm1', triage, true)
    patchQualityTriage(client, key, 'm1', triage, true)
    expect(client.getQueryData(key)).toMatchObject({ items: [], total: 25, totalPages: 1 })
    patchQualityTriage(client, key, 'm1', triage, false, { assistantMessageId: 'm1' } as never)
    expect(client.getQueryData(key)).toMatchObject({ items: [{ assistantMessageId: 'm1' }], total: 26, totalPages: 2 })
    expect(qualityTurnRemainsVisible({ assistantMessageId: 'm1' } as never, triage, {
      page: 1, pageSize: 25, triageStates: ['resolved'], resolutionReasons: ['other'], resolutionFrom: '2025-12-01T00:00:00.000Z', resolutionTo: '2027-01-01T00:00:00.000Z',
    })).toBe(true)
    expect(qualityTurnRemainsVisible({ assistantMessageId: 'm1' } as never, triage, {
      page: 1, pageSize: 25, activeNegativeFeedbackOnly: true,
    })).toBe(false)
  })

  it('makes every transport discriminator observable while set ordering remains request-equivalent', () => {
    const base = { page: 1, pageSize: 25 }
    const ordered = normalizeQualityTurnsRequest({ ...base, statuses: ['failed', 'completed'], actions: [
      { skillName: 'b', outcome: 'failed' }, { skillName: 'a', outcome: 'completed' },
    ], minTotalLatencyMs: 1, maxTotalLatencyMs: 2, from: '2026-01-01', to: '2026-01-02', resolutionFrom: '2026-01-03', resolutionTo: '2026-01-04' })
    const reordered = normalizeQualityTurnsRequest({ ...base, statuses: ['completed', 'failed'], actions: [
      { skillName: 'a', outcome: 'completed' }, { skillName: 'b', outcome: 'failed' },
    ], minTotalLatencyMs: 1, maxTotalLatencyMs: 2, from: '2026-01-01', to: '2026-01-02', resolutionFrom: '2026-01-03', resolutionTo: '2026-01-04' })
    expect(ordered).toEqual(reordered)
    expect(qualityTurnsApiOptions({ ...ordered, minTotalLatencyMs: 3 })).not.toEqual(qualityTurnsApiOptions(ordered))
    expect(qualityTurnsApiOptions({ ...ordered, page: 2 })).not.toEqual(qualityTurnsApiOptions(ordered))
  })

  it('recognizes triage, reason, date, and active-negative visibility boundaries', () => {
    const record = { state: 'resolved', version: 2, resolution: { reason: 'other', note: null }, legacyReason: null, closedAt: '2026-01-02T00:00:00.000Z', updatedAt: null } as never
    const turn = { assistantMessageId: 'm1' } as never
    expect(qualityTurnRemainsVisible(turn, record, { page: 1, pageSize: 25, triageStates: ['open'] })).toBe(false)
    expect(qualityTurnRemainsVisible(turn, record, { page: 1, pageSize: 25, resolutionReasons: ['platform_bug'] })).toBe(false)
    expect(qualityTurnRemainsVisible(turn, record, { page: 1, pageSize: 25, resolutionTo: '2026-01-02T00:00:00.000Z' })).toBe(false)
    expect(qualityTurnRemainsVisible(turn, record, { page: 1, pageSize: 25, activeNegativeFeedbackOnly: true })).toBe(false)
    expect(qualityTurnRemainsVisible(turn, { state: 'acknowledged', version: 2, resolution: null, legacyReason: null, closedAt: null, updatedAt: null } as never, {
      page: 1, pageSize: 25, activeNegativeFeedbackOnly: true,
    })).toBe(true)
  })

  it('only allows the current interaction to finish a frozen page', () => {
    const first = beginQualityInteraction(0)
    const retry = beginQualityInteraction(first)
    const keyChange = beginQualityInteraction(retry)
    expect(ownsQualityInteraction(retry, first)).toBe(false)
    expect(ownsQualityInteraction(keyChange, retry)).toBe(false)
    expect(ownsQualityInteraction(keyChange, keyChange)).toBe(true)
  })

  it('starts a new freeze generation for each retry', () => {
    const first = beginQualityInteractionController({ currentId: 0, frozenId: null })
    const retry = beginQualityInteractionController(first.state)
    expect(first.effects).toEqual(['freeze'])
    expect(retry.effects).toEqual(['freeze'])
    expect(retry.id).toBeGreaterThan(first.id)
  })

  it('retains cached stats and turns on background failure with their policy floor', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const turns = vi.spyOn(qualityApi, 'listTurns')
      .mockResolvedValueOnce({ items: [], total: 0, page: 2, pageSize: 25, totalPages: 0 } as never)
      .mockRejectedValueOnce(new Error('temporary'))
    const stats = vi.spyOn(qualityApi, 'getStats')
      .mockResolvedValueOnce({ range: '7d' } as never)
      .mockRejectedValueOnce(new Error('temporary'))
    const root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement('div', null, createElement(Probe, { enabled: true, workspaceId: 'workspace-a' }), createElement(StatsProbe))))
      await flush()
    })
    await client.refetchQueries()
    const queries = client.getQueryCache().getAll()
    expect(queries.find((query) => query.queryKey[3] === 'turns')?.state.data).toBeTruthy()
    expect(queries.find((query) => query.queryKey[3] === 'stats')?.state.data).toBeTruthy()
    expect(turns).toHaveBeenCalledTimes(2)
    expect(stats).toHaveBeenCalledTimes(2)
    await act(async () => { root.unmount() })
  })

  it('settles production callbacks as patch, invalidate, then owned presentation', () => {
    const effects: string[] = []
    settleQualityInteraction({
      currentId: 2, interactionId: 2, outcome: 'success',
      patch: () => effects.push('patch'), invalidate: () => effects.push('invalidate'), present: () => effects.push('present'),
    })
    expect(effects).toEqual(['patch', 'invalidate', 'present'])
    settleQualityInteraction({
      currentId: 3, interactionId: 2, outcome: 'conflict',
      patch: () => effects.push('old-patch'), invalidate: () => effects.push('old-invalidate'), present: () => effects.push('old-present'),
    })
    expect(effects).toEqual(['patch', 'invalidate', 'present', 'old-patch', 'old-invalidate'])
    settleQualityInteraction({ currentId: 3, interactionId: 3, outcome: 'failure', present: () => effects.push('failure') })
    settleQualityInteraction({ currentId: 3, interactionId: 3, outcome: 'cancel', present: () => effects.push('cancel') })
    expect(effects).toEqual(['patch', 'invalidate', 'present', 'old-patch', 'old-invalidate', 'failure', 'cancel'])
  })
})
