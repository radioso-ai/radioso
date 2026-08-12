import { describe, expect, it } from 'vitest'

import {
  deriveCopilotSuggestedQuestions,
  registerCopilotEntity,
  resolveCopilotEntityLabel,
  truncateCopilotSelection,
  type CopilotEntity,
} from '@/lib/copilot-context'

const entity = (id: string, focused = false): CopilotEntity => ({
  type: 'conversation',
  id,
  label: `Conversation ${id}`,
  focused,
})

describe('copilot entity registry transforms', () => {
  it('caps at 30 and keeps focused entities first', () => {
    const current = Array.from({ length: 30 }, (_, index) => entity(String(index)))
    const registered = registerCopilotEntity(current, entity('focused', true))
    expect(registered).toHaveLength(30)
    expect(registered[0]).toMatchObject({ id: 'focused', focused: true })
    expect(registered.some((candidate) => candidate.id === '29')).toBe(true)
    expect(registered.some((candidate) => candidate.id === '0')).toBe(false)
  })

  it('limits focused ordering to three entries while retaining labels', () => {
    const registered = ['one', 'two', 'three', 'four'].reduce(
      (current, id) => registerCopilotEntity(current, entity(id, true)),
      [] as CopilotEntity[],
    )
    expect(registered.slice(0, 3).every((candidate) => candidate.focused)).toBe(true)
    expect(registered[3]).toMatchObject({ id: 'four', focused: false })
    expect(resolveCopilotEntityLabel(registered, 'conversation', 'two')).toBe('Conversation two')
  })

  it('bounds selection at the client boundary', () => {
    expect(truncateCopilotSelection(`  ${'x'.repeat(2100)}  `)).toHaveLength(2000)
    expect(truncateCopilotSelection('   ')).toBeNull()
  })

  it('derives focused-context suggestions', () => {
    expect(deriveCopilotSuggestedQuestions('activity', [entity('42', true)])[0]).toContain('Conversation 42')
    expect(deriveCopilotSuggestedQuestions('quality', []).some((question) => question.includes('What needs attention'))).toBe(true)
  })
})
