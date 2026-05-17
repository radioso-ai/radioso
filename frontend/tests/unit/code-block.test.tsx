import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { highlightCode, resolveLanguage, SUPPORTED_LANGUAGES } from '@/components/markdown/highlighter'

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

describe('highlightCode', () => {
  it('returns syntax tokens instead of HTML for user-controlled code content', async () => {
    const highlighted = await highlightCode('const value = "<img src=x onerror=alert(1)>"', 'ts')
    const tokenContent = highlighted.flat().map((token) => token.content).join('')
    const rendered = renderToStaticMarkup(<span>{tokenContent}</span>)

    expect(tokenContent).toBe('const value = "<img src=x onerror=alert(1)>"')
    expect(rendered).not.toContain('<img src=x')
    expect(rendered).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })

  it('preserves trailing blank lines from highlighted code', async () => {
    const highlighted = await highlightCode('const a = 1\n\n', 'ts')

    expect(highlighted).toHaveLength(3)
    expect(highlighted[1]).toEqual([])
    expect(highlighted[2]).toEqual([])
  })
})
