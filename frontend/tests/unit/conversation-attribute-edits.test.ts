import { describe, expect, it } from 'vitest'

import type { ConversationAttribute } from '@/lib/api-types'
import {
  applyAttributeChange,
  attributeResetAction,
  settableOptions,
  unsetAttributeChoices,
} from '@/lib/conversation-attribute-edits'
import type { AttributeFilterChoice } from '@/lib/conversation-attributes'

const attribute = (overrides: Partial<ConversationAttribute>): ConversationAttribute => ({
  name: 'topic',
  valueType: 'enum',
  value: 'billing',
  option: { label: 'Billing', archived: false },
  redacted: false,
  scope: 'conversation',
  writtenBy: { kind: 'operator', ref: 'user-1' },
  updatedAt: '2026-11-22T09:30:00.000Z',
  classified: false,
  ...overrides,
})

const choices: AttributeFilterChoice[] = [
  { name: 'region', options: [{ key: 'eu', label: 'Europe', archived: false }] },
  {
    name: 'topic',
    options: [
      { key: 'billing', label: 'Billing', archived: false },
      { key: 'legacy', label: 'Old plans', archived: true },
      { key: 'shipping', label: 'Shipping', archived: false },
    ],
  },
  { name: 'retired', options: [{ key: 'old', label: 'Old', archived: true }] },
]

describe('attributeResetAction', () => {
  it('hands a teammate\'s value of an attribute the AI fills back to the AI', () => {
    expect(attributeResetAction(attribute({ classified: true }))).toBe('reset')
  })

  it('clears a teammate\'s own value of an attribute nothing fills', () => {
    expect(attributeResetAction(attribute({ classified: false }))).toBe('clear')
  })

  it('offers nothing for a value the AI, the website or a routine set, or one kept for the visitor', () => {
    expect(attributeResetAction(attribute({ classified: true, writtenBy: { kind: 'classifier', ref: null } }))).toBeNull()
    expect(attributeResetAction(attribute({ classified: true, writtenBy: { kind: 'api', ref: 'credential-1' } }))).toBeNull()
    expect(attributeResetAction(attribute({ writtenBy: { kind: 'routine', ref: 'routine-1:run-1' } }))).toBeNull()
    expect(attributeResetAction(attribute({ classified: true, scope: 'session' }))).toBeNull()
    expect(attributeResetAction(attribute({ redacted: true }))).toBeNull()
  })
})

describe('settableOptions', () => {
  it('offers the active options of a Choice attribute a teammate can set', () => {
    expect(settableOptions(choices, attribute({}))).toEqual([
      { key: 'billing', label: 'Billing' },
      { key: 'shipping', label: 'Shipping' },
    ])
  })

  it('offers none for a Private value, a value that is not a Choice, or an attribute the catalog does not offer', () => {
    expect(settableOptions(choices, attribute({ redacted: true }))).toEqual([])
    expect(settableOptions(choices, attribute({ name: 'plan', valueType: 'string' }))).toEqual([])
    expect(settableOptions(choices, attribute({ name: 'care_need' }))).toEqual([])
    expect(settableOptions(choices, attribute({ name: 'retired' }))).toEqual([])
  })
})

describe('unsetAttributeChoices', () => {
  it('lists the Choice attributes the block shows no row for, with their active options', () => {
    expect(unsetAttributeChoices(choices, [attribute({})])).toEqual([
      { name: 'region', options: [{ key: 'eu', label: 'Europe' }] },
    ])
  })
})

describe('applyAttributeChange', () => {
  const region = attribute({ name: 'region', value: 'eu', option: { label: 'Europe', archived: false } })

  it('replaces the attribute the edit changed, and keeps name order', () => {
    const changed = attribute({ value: 'shipping', option: { label: 'Shipping', archived: false } })

    expect(applyAttributeChange([region, attribute({})], 'topic', changed)).toEqual([region, changed])
    expect(applyAttributeChange([attribute({})], 'region', region)).toEqual([region, attribute({})])
  })

  it('drops an attribute nothing holds after a reset', () => {
    expect(applyAttributeChange([region, attribute({})], 'topic', null)).toEqual([region])
    expect(applyAttributeChange(undefined, 'topic', null)).toEqual([])
  })
})
