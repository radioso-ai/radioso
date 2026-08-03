import { describe, expect, it } from 'vitest'

import {
  defaultUsageDetailsQuery,
  formatLlmCallCount,
  formatUsageOutput,
  formatUsageTokenCount,
  parseUsageDetailsQuery,
  readUsageDetailsQuery,
  writeUsageDetailsQuery,
} from '@/lib/usage-details'

describe('usage details helpers', () => {
  it('defaults to a 30-day UTC range ending today', () => {
    expect(defaultUsageDetailsQuery(new Date('2026-06-09T17:45:00.000Z'))).toEqual({
      from: '2026-05-11',
      to: '2026-06-09',
    })
  })

  it('accepts valid URL filters and rejects malformed date filters', () => {
    expect(parseUsageDetailsQuery(new URLSearchParams('usageFrom=2026-06-01&usageTo=2026-06-09&usageWorkspace=workspace-1'))).toEqual({
      from: '2026-06-01',
      to: '2026-06-09',
      workspaceId: 'workspace-1',
    })
    expect(parseUsageDetailsQuery(new URLSearchParams('usageFrom=June&usageTo=2026-06-09'))).toBeUndefined()

    expect(readUsageDetailsQuery(new URLSearchParams('usageFrom=2026-06-01&usageTo=2026-06-09&usageWorkspace=workspace-1'))).toEqual({
      from: '2026-06-01',
      to: '2026-06-09',
      workspaceId: 'workspace-1',
    })
    expect(readUsageDetailsQuery(new URLSearchParams('usageFrom=June&usageTo=2026-06-09'), new Date('2026-06-09T12:00:00.000Z'))).toEqual({
      from: '2026-05-11',
      to: '2026-06-09',
    })
  })

  it('updates only usage-detail parameters so dashboard URL state is retained', () => {
    expect(writeUsageDetailsQuery(
      new URLSearchParams('view=usage&tab=overview&usageWorkspace=old-workspace'),
      { from: '2026-06-01', to: '2026-06-09', workspaceId: 'workspace-1' },
    ).toString()).toBe('view=usage&tab=overview&usageWorkspace=workspace-1&usageFrom=2026-06-01&usageTo=2026-06-09')

    expect(writeUsageDetailsQuery(
      new URLSearchParams('view=usage&usageWorkspace=workspace-1'),
      { from: '2026-06-01', to: '2026-06-09' },
    ).toString()).toBe('view=usage&usageFrom=2026-06-01&usageTo=2026-06-09')
  })

  it('formats unavailable token dimensions distinctly from zero', () => {
    expect(formatUsageTokenCount(null)).toBe('—')
    expect(formatUsageTokenCount(0)).toBe('0')
    expect(formatUsageTokenCount(12345)).toBe('12,345')
  })

  it('shows completion tokens when separately reported reasoning is unavailable', () => {
    expect(formatUsageOutput({ completion: 885, visibleOutput: null })).toEqual({
      tokens: 885,
      detail: 'Reasoning not reported separately',
    })
    expect(formatUsageOutput({ completion: 885, visibleOutput: null, reasoningCoverage: 'partial' })).toEqual({
      tokens: 885,
      detail: 'Reasoning only partially reported',
    })
    expect(formatUsageOutput({ completion: 885, visibleOutput: 632, reasoningCoverage: 'complete' })).toEqual({
      tokens: 632,
      detail: 'Completion 885',
    })
  })

  it('formats compact LLM call counts', () => {
    expect(formatLlmCallCount({ total: 5, failed: 0 })).toBe('5')
    expect(formatLlmCallCount({ total: 5, failed: 1 })).toBe('5 (1 failed)')
  })
})
