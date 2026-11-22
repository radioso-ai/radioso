import { describe, expect, it } from 'vitest'

import type { ContextVariable, ConversationAttribute } from '@/lib/api-types'
import { attributeValueText, attributeWrittenText } from '@/components/dashboard/settings/attribute-copy'
import { buildAttributeFilterChoices, decodeAttributeFilter, encodeAttributeFilter } from '@/lib/conversation-attributes'

const variable = (overrides: Partial<ContextVariable>): ContextVariable => ({
  id: 'variable-1',
  workspaceId: 'workspace-1',
  name: 'topic',
  description: null,
  valueType: 'enum',
  options: [
    { key: 'billing', label: 'Billing', description: null, archived: false },
    { key: 'legacy', label: 'Old plans', description: null, archived: true },
  ],
  trustTier: 'unverified',
  sensitivity: 'normal',
  defaultSurfacing: 'on_reference',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...overrides,
})

const attribute = (overrides: Partial<ConversationAttribute>): ConversationAttribute => ({
  name: 'topic',
  valueType: 'enum',
  value: 'billing',
  option: { label: 'Billing', archived: false },
  redacted: false,
  scope: 'conversation',
  writtenBy: { kind: 'classifier', ref: null },
  updatedAt: '2026-11-22T09:30:00.000Z',
  ...overrides,
})

describe('buildAttributeFilterChoices', () => {
  it('offers each Choice attribute that is not Private, by name, with its archived options marked', () => {
    const choices = buildAttributeFilterChoices([
      variable({ name: 'topic' }),
      variable({ name: 'plan', valueType: 'string', options: null }),
      variable({ name: 'health', sensitivity: 'sensitive' }),
      variable({ name: 'region', options: [{ key: 'eu', label: 'Europe', description: null, archived: false }] }),
      variable({ name: 'empty', options: [] }),
    ])

    expect(choices).toEqual([
      { name: 'region', options: [{ key: 'eu', label: 'Europe', archived: false }] },
      {
        name: 'topic',
        options: [
          { key: 'billing', label: 'Billing', archived: false },
          { key: 'legacy', label: 'Old plans', archived: true },
        ],
      },
    ])
  })
})

describe('attribute filter select values', () => {
  it('round-trips a name and option key, including characters a separator would split', () => {
    const filter = { name: 'topic', option: 'a:b|c' }
    expect(decodeAttributeFilter(encodeAttributeFilter(filter))).toEqual(filter)
  })

  it('reads anything else, such as the "all" sentinel, as no filter', () => {
    expect(decodeAttributeFilter('__all_attributes__')).toBeNull()
    expect(decodeAttributeFilter('["topic"]')).toBeNull()
    expect(decodeAttributeFilter('[1, 2]')).toBeNull()
  })
})

describe('attributeValueText', () => {
  it('shows a Choice value as its option label', () => {
    expect(attributeValueText(attribute({}))).toBe('Billing')
  })

  it('shows a key no option has as the key itself', () => {
    expect(attributeValueText(attribute({ value: 'gone', option: undefined }))).toBe('gone')
  })

  it('shows Private data instead of a redacted value', () => {
    expect(attributeValueText(attribute({ value: null, option: undefined, redacted: true }))).toBe('Private data')
  })

  it('shows text as written and JSON as compact JSON', () => {
    expect(attributeValueText(attribute({ valueType: 'string', value: 'Pro', option: undefined }))).toBe('Pro')
    expect(attributeValueText(attribute({ valueType: 'json', value: { items: 2 }, option: undefined }))).toBe('{"items":2}')
  })
})

describe('attributeWrittenText', () => {
  it('names the writer', () => {
    expect(attributeWrittenText(attribute({}))).toBe('Set by the AI')
    expect(attributeWrittenText(attribute({ writtenBy: { kind: 'api', ref: 'credential-1' } }))).toBe('Set by your website or API')
    expect(attributeWrittenText(attribute({ writtenBy: { kind: 'operator', ref: null } }))).toBe('Set by your team')
    expect(attributeWrittenText(attribute({ writtenBy: { kind: 'routine', ref: null } }))).toBe('Set by a routine')
  })

  it('says a value kept for the session or the customer is for this visitor', () => {
    expect(attributeWrittenText(attribute({ scope: 'session', writtenBy: { kind: 'api', ref: null } })))
      .toBe('Set by your website or API for this visitor')
    expect(attributeWrittenText(attribute({ scope: 'customer', writtenBy: { kind: 'api', ref: null } })))
      .toBe('Set by your website or API for this visitor')
  })
})
