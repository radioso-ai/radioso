import { describe, expect, it } from 'vitest'

import { computeSkillGroupInfo, type SkillGroupedMessage } from '@/lib/skill-thread-grouping'

const assistant = (
  skillName?: string,
  phase: 'active' | 'completed' | 'failed' = 'active',
  localizedTitle?: string,
): SkillGroupedMessage => ({
  role: 'assistant',
  skill: skillName ? { skillName, phase, localizedTitle } : undefined,
})

const user: SkillGroupedMessage = { role: 'user' }

describe('computeSkillGroupInfo', () => {
  it('returns empty group info when no messages carry a skill', () => {
    const info = computeSkillGroupInfo([assistant(), user, assistant()])
    expect(info.every((entry) => entry.groupKey === null)).toBe(true)
  })

  it('marks a single skill-bearing assistant message as both start and end', () => {
    const info = computeSkillGroupInfo([assistant('s.one')])
    expect(info[0]).toMatchObject({ isGroupStart: true, isGroupEnd: true })
    expect(info[0].skill?.skillName).toBe('s.one')
  })

  it('groups consecutive assistant messages with the same skill across user replies', () => {
    const messages = [
      assistant('s.one', 'active'),
      user,
      assistant('s.one', 'active'),
      user,
      assistant('s.one', 'completed'),
    ]
    const info = computeSkillGroupInfo(messages)
    expect(info.map((entry) => entry.groupKey)).toEqual([
      'skill-0',
      'skill-0',
      'skill-0',
      'skill-0',
      'skill-0',
    ])
    expect(info[0].isGroupStart).toBe(true)
    expect(info[4].isGroupEnd).toBe(true)
    expect(info[4].skill?.phase).toBe('completed')
  })

  it('breaks a skill group when an assistant message with no skill or a different skill appears', () => {
    const messages = [
      assistant('s.one', 'active'),
      user,
      assistant(undefined),
      assistant('s.two', 'active'),
    ]
    const info = computeSkillGroupInfo(messages)
    expect(info[0].groupKey).toBe('skill-0')
    expect(info[1].groupKey).toBe(null)
    expect(info[2].groupKey).toBe(null)
    expect(info[3].groupKey).toBe('skill-1')
    expect(info[3].isGroupStart).toBe(true)
    expect(info[3].isGroupEnd).toBe(true)
  })

  it('uses the latest phase and receipt for the group (so completion replaces active)', () => {
    const messages: SkillGroupedMessage[] = [
      assistant('s.one', 'active'),
      user,
      {
        role: 'assistant',
        skill: {
          skillName: 's.one',
          phase: 'completed',
          receipt: { fields: [{ name: 'email', displayName: 'email', value: 'a@b.c' }] },
        },
      },
    ]
    const info = computeSkillGroupInfo(messages)
    expect(info[0].skill?.phase).toBe('completed')
    expect(info[2].skill?.phase).toBe('completed')
    expect(info[2].skill?.receipt?.fields[0]?.value).toBe('a@b.c')
  })

  it('pins the chip title to the first non-empty localized title in the group (sticky)', () => {
    const messages = [
      assistant('s.one', 'active', 'Связаться'),
      user,
      assistant('s.one', 'active', 'Contact request'),
      user,
      assistant('s.one', 'completed'),
    ]
    const info = computeSkillGroupInfo(messages)
    expect(info[0].skill?.localizedTitle).toBe('Связаться')
    expect(info[4].skill?.localizedTitle).toBe('Связаться')
  })

  it('adopts a later localized title only if no earlier message provided one', () => {
    const messages = [
      assistant('s.one', 'active'),
      user,
      assistant('s.one', 'completed', 'Готово'),
    ]
    const info = computeSkillGroupInfo(messages)
    expect(info[0].skill?.localizedTitle).toBe('Готово')
  })
})
