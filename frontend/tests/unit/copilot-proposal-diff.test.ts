import { describe, expect, it } from 'vitest'

import { buildCopilotProposalDiff } from '@/lib/copilot-proposal-diff'

describe('buildCopilotProposalDiff', () => {
  it('does not list a null or absent value on a create as a change', () => {
    const rows = buildCopilotProposalDiff({
      current: { definition: null, enablement: null },
      proposed: { definition: { name: 'topic', maxAgeSeconds: null }, enablement: { source: 'classified', resolverSkillId: null } },
    })
    expect(rows.map((row) => row.path)).toEqual(['$.definition.name', '$.enablement.source'])
  })

  it('treats null and absent as the same no-value on both sides', () => {
    expect(buildCopilotProposalDiff({ current: { a: null }, proposed: { a: undefined } })).toEqual([])
    expect(buildCopilotProposalDiff({ current: { a: undefined }, proposed: { a: null } })).toEqual([])
  })

  it('still lists a value set to null or filled in from null', () => {
    expect(buildCopilotProposalDiff({ current: { a: 'x' }, proposed: { a: null } }).map((row) => [row.path, row.kind])).toEqual([['$.a', 'changed']])
    expect(buildCopilotProposalDiff({ current: { a: null }, proposed: { a: 'x' } }).map((row) => [row.path, row.kind])).toEqual([['$.a', 'changed']])
  })

  it('reads a removed key as removed and an added key as added', () => {
    expect(buildCopilotProposalDiff({ current: { gone: 'x' }, proposed: {} }).map((row) => row.kind)).toEqual(['removed'])
    expect(buildCopilotProposalDiff({ current: {}, proposed: { fresh: 'y' } }).map((row) => row.kind)).toEqual(['added'])
  })
})
