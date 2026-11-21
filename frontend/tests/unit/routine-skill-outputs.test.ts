import { describe, expect, it } from 'vitest'

import type { SkillAuthoringOutcome, SkillAuthoringOutput } from '@/lib/api-routine-skill-catalog'
import { assignedVariables, guardOpFitsVariable, guardOpsForVariable, listBackedVariableIds, nextUnassignedOutput, outcomeRuleChoices, outputVariableType } from '@/lib/routine-skill-outputs'
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

  it('types each variable a step sets from the output it reads', () => {
    const outputsOf = (ref: string) => (ref === 'order_status' ? [status, total, items] : undefined)
    expect(assignedVariables([
      { kind: 'chat', toolRef: null, outputAssignments: {} },
      { kind: 'tool', toolRef: 'order_status', outputAssignments: { total: 'order_total', items: 'found_orders', status: '' } },
      { kind: 'tool', toolRef: 'unknown_skill', outputAssignments: { reference: 'reference' } },
    ], outputsOf)).toEqual([
      { id: 'order_total', type: 'number', holdsList: false },
      { id: 'found_orders', type: 'text', holdsList: true },
      { id: 'reference', type: 'text', holdsList: false },
    ])
  })

  it('offers each declared outcome once, by the name a step reports', () => {
    // An API request skill's catalog marks every outcome but `failed` with the broad status `completed`.
    const outcomes: SkillAuthoringOutcome[] = [
      { name: 'completed', displayName: 'completed', status: 'completed' },
      { name: 'not_found', displayName: 'not_found', status: 'completed' },
      { name: 'rejected', displayName: 'rejected', status: 'completed' },
      { name: 'not_found', displayName: 'not_found', status: 'completed' },
      { name: 'failed', displayName: 'Failed', status: 'failed' },
    ]
    expect(outcomeRuleChoices(outcomes)).toEqual([
      { value: 'completed', label: 'completed' },
      { value: 'not_found', label: 'not_found' },
      { value: 'rejected', label: 'rejected' },
      { value: 'failed', label: 'Failed' },
    ])
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
