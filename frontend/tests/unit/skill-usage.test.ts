import { describe, expect, it } from 'vitest'

import {
  countSkillUsage,
  describeSkillUsage,
  NO_SKILL_USAGE,
  type SkillUsageRoutine,
} from '@/components/dashboard/settings/skills/skill-usage'

const routine = (input: Partial<SkillUsageRoutine> & Pick<SkillUsageRoutine, 'lineageId'>): SkillUsageRoutine => ({
  status: 'published',
  steps: [],
  ...input,
})

describe('countSkillUsage', () => {
  it('counts the directives whose binding names the skill', () => {
    const usage = countSkillUsage(
      [
        { binding: { skillName: 'issue_refund' } },
        { binding: { skillName: 'issue_refund' } },
        { binding: { skillName: 'lookup_order' } },
        { binding: null },
        {},
      ],
      [],
    )

    expect(usage.get('issue_refund')).toEqual({ directives: 2, routines: 0 })
    expect(usage.get('lookup_order')).toEqual({ directives: 1, routines: 0 })
  })

  it('counts a routine once however many of its steps call the skill', () => {
    const usage = countSkillUsage([], [
      routine({
        lineageId: 'lineage-1',
        steps: [{ toolRef: 'issue_refund' }, { toolRef: 'issue_refund' }, { toolRef: null }, {}],
      }),
    ])

    expect(usage.get('issue_refund')).toEqual({ directives: 0, routines: 1 })
  })

  it('counts a lineage once when its draft and published versions both call the skill', () => {
    const usage = countSkillUsage([], [
      routine({ lineageId: 'lineage-1', status: 'published', steps: [{ toolRef: 'issue_refund' }] }),
      routine({ lineageId: 'lineage-1', status: 'draft', steps: [{ toolRef: 'issue_refund' }] }),
      routine({ lineageId: 'lineage-2', status: 'draft', steps: [{ toolRef: 'issue_refund' }] }),
    ])

    expect(usage.get('issue_refund')).toEqual({ directives: 0, routines: 2 })
  })

  it('ignores routine versions that can no longer fire', () => {
    const usage = countSkillUsage([], [
      routine({ lineageId: 'lineage-1', status: 'archived', steps: [{ toolRef: 'issue_refund' }] }),
      routine({ lineageId: 'lineage-2', status: 'superseded', steps: [{ toolRef: 'issue_refund' }] }),
    ])

    expect(usage.get('issue_refund')).toBeUndefined()
  })

  it('sums both surfaces for a skill used by each', () => {
    const usage = countSkillUsage(
      [{ binding: { skillName: 'issue_refund' } }],
      [routine({ lineageId: 'lineage-1', steps: [{ toolRef: 'issue_refund' }] })],
    )

    expect(usage.get('issue_refund')).toEqual({ directives: 1, routines: 1 })
  })
})

describe('describeSkillUsage', () => {
  it('names an orphan skill rather than reporting a zero', () => {
    expect(describeSkillUsage(NO_SKILL_USAGE)).toBe('Not used by a directive or routine')
  })

  it('reports only the surfaces that use the skill', () => {
    expect(describeSkillUsage({ directives: 1, routines: 0 })).toBe('Used by 1 directive')
    expect(describeSkillUsage({ directives: 0, routines: 2 })).toBe('Used by 2 routines')
    expect(describeSkillUsage({ directives: 2, routines: 1 })).toBe('Used by 2 directives and 1 routine')
  })
})
