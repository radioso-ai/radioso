import { describe, expect, it } from 'vitest'

import {
  countSkillUsage,
  describeSkillUsage,
  NO_SKILL_USAGE,
  type SkillUsageRoutine,
} from '@/components/dashboard/settings/skills/skill-usage'

const routine = (input: Partial<SkillUsageRoutine> = {}): SkillUsageRoutine => ({
  enabled: true,
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
      routine({ steps: [{ toolRef: 'issue_refund' }, { toolRef: 'issue_refund' }, { toolRef: null }, {}] }),
      routine({ steps: [{ toolRef: 'issue_refund' }] }),
    ])

    expect(usage.get('issue_refund')).toEqual({ directives: 0, routines: 2 })
  })

  it('ignores a disabled routine, which cannot fire', () => {
    const usage = countSkillUsage([], [
      routine({ enabled: false, steps: [{ toolRef: 'issue_refund' }] }),
    ])

    expect(usage.get('issue_refund')).toBeUndefined()
  })

  it('sums both surfaces for a skill used by each', () => {
    const usage = countSkillUsage(
      [{ binding: { skillName: 'issue_refund' } }],
      [routine({ steps: [{ toolRef: 'issue_refund' }] })],
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
