import { describe, expect, it } from 'vitest'

import type { SkillAuthoringOutput } from '@/lib/api-routine-skill-catalog'
import { guardOpFitsVariable, guardOpsForVariable, listBackedVariableIds, nextUnassignedOutput, outputVariableType, variablesFittingOutput } from '@/lib/routine-skill-outputs'
import { fieldGuardOpsForType } from '@/lib/routine-prose'

const status: SkillAuthoringOutput = { name: 'status', type: 'text', required: true }
const total: SkillAuthoringOutput = { name: 'total', type: 'number', required: false }
const flag: SkillAuthoringOutput = { name: 'paid', type: 'boolean', required: false }
const items: SkillAuthoringOutput = { name: 'items', type: 'list', required: false, fields: [] }

describe('routine skill outputs', () => {
  it('stores an output as the variable type that makes its checks fit', () => {
    expect(fieldGuardOpsForType(outputVariableType(total))).toContain('gt')
    expect(fieldGuardOpsForType(outputVariableType(total))).not.toContain('in')
    expect(fieldGuardOpsForType(outputVariableType(flag))).toEqual(['is_true', 'is_false', 'is_present', 'is_absent'])
    expect(outputVariableType(items)).toBe('text')
  })

  it('offers only the variables of the output type', () => {
    const variables = [
      { id: 'amount', type: 'number' as const },
      { id: 'name', type: 'text' as const },
    ]
    expect(variablesFittingOutput(variables, total).map((variable) => variable.id)).toEqual(['amount'])
    expect(variablesFittingOutput(variables, undefined)).toHaveLength(2)
  })

  it('picks the next output that is not assigned yet', () => {
    expect(nextUnassignedOutput([status, total], { status: 'order_status' })).toBe(total)
    expect(nextUnassignedOutput([status], { status: 'order_status' })).toBeUndefined()
  })

  it('knows a variable holds a list from the step that sets it', () => {
    const outputsOf = (ref: string) => (ref === 'order_status' ? [status, items] : undefined)
    const ids = listBackedVariableIds([
      { kind: 'tool', toolRef: 'order_status', outputAssignments: { items: 'found_orders', status: 'order_state' } },
      { kind: 'action', actionType: 'order_status', outputAssignments: { items: '' } },
      { kind: 'tool', toolRef: 'other', outputAssignments: { items: 'ignored' } },
      { kind: 'chat', toolRef: 'order_status', outputAssignments: { items: 'ignored_too' } },
    ], outputsOf)
    expect([...ids]).toEqual(['found_orders'])
  })

  it('limits a list-backed variable to is-set and is-not-set, and flags any other stored check', () => {
    expect(guardOpsForVariable('text', true)).toEqual(['is_present', 'is_absent'])
    expect(guardOpsForVariable('text', false)).toContain('equals')
    expect(guardOpFitsVariable('is_present', 'text', true)).toBe(true)
    expect(guardOpFitsVariable('equals', 'text', true)).toBe(false)
    expect(guardOpFitsVariable('equals', 'text', false)).toBe(true)
  })
})
