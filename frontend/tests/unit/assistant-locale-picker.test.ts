import { describe, expect, it } from 'vitest'

import {
  getAssistantLocaleLabel,
  resolveAssistantLocaleInput,
} from '@/components/dashboard/settings/workspace-assistant-channels-tab'

describe('assistant greeting locale picker', () => {
  it('maps plain language labels to stored locale tags', () => {
    expect(resolveAssistantLocaleInput('Italian')).toBe('it')
    expect(resolveAssistantLocaleInput(' english ')).toBe('en')
    expect(resolveAssistantLocaleInput('ES')).toBe('es')
  })

  it('persists valid custom locale tags typed directly', () => {
    expect(resolveAssistantLocaleInput('en-US')).toBe('en-US')
    expect(resolveAssistantLocaleInput(' fr-CA ')).toBe('fr-CA')
  })

  it('supports no fallback and preserves unknown stored tags for display', () => {
    expect(resolveAssistantLocaleInput('No fallback')).toBeNull()
    expect(resolveAssistantLocaleInput('')).toBeNull()
    expect(resolveAssistantLocaleInput('Klingon')).toBeUndefined()
    expect(getAssistantLocaleLabel('en')).toBe('English')
    expect(getAssistantLocaleLabel(null)).toBe('No fallback')
    expect(getAssistantLocaleLabel('en-GB')).toBe('Custom locale: en-GB')
  })
})
