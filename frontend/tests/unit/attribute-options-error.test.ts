import { describe, expect, it } from 'vitest'

import { attributeOptionsError } from '@/components/dashboard/settings/attribute-options-editor'
import type { ContextVariableOption } from '@/lib/api'

const option = (key: string, archived = false): ContextVariableOption => ({ key, label: key, description: null, archived })

describe('attributeOptionsError', () => {
  it('refuses a key that does not start with a letter', () => {
    expect(attributeOptionsError([option('_internal')])).toBe('Keys use letters, numbers and underscores, and start with a letter.')
    expect(attributeOptionsError([option('tier_2')])).toBeNull()
  })

  it('refuses two keys that differ only in case, as the API does', () => {
    expect(attributeOptionsError([option('billing'), option('Billing')])).toBe('Key "Billing" is used twice.')
    expect(attributeOptionsError([option('billing'), option('billing_eu')])).toBeNull()
  })

  it('needs at least one option that is not archived', () => {
    expect(attributeOptionsError([option('billing', true), option('shipping', true)])).toBe('Keep at least one option active.')
    expect(attributeOptionsError([option('billing', true), option('shipping')])).toBeNull()
  })
})
