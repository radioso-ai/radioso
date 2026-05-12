import { describe, expect, it } from 'vitest'

import { resolveLanguage, SUPPORTED_LANGUAGES } from '@/components/markdown/highlighter'

describe('resolveLanguage', () => {
  it('returns canonical names for supported languages', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      expect(resolveLanguage(language)).toBe(language)
    }
  })

  it('maps common aliases to canonical names', () => {
    expect(resolveLanguage('typescript')).toBe('ts')
    expect(resolveLanguage('JavaScript')).toBe('js')
    expect(resolveLanguage('yml')).toBe('yaml')
    expect(resolveLanguage('py')).toBe('python')
    expect(resolveLanguage('shell')).toBe('bash')
    expect(resolveLanguage('zsh')).toBe('bash')
    expect(resolveLanguage('markdown')).toBe('md')
    expect(resolveLanguage('text')).toBe('plaintext')
  })

  it('normalizes casing and whitespace', () => {
    expect(resolveLanguage('  TS  ')).toBe('ts')
    expect(resolveLanguage('JSON')).toBe('json')
  })

  it('falls back to plaintext for unknown or empty values', () => {
    expect(resolveLanguage('cobol')).toBe('plaintext')
    expect(resolveLanguage(undefined)).toBe('plaintext')
    expect(resolveLanguage('')).toBe('plaintext')
  })
})
