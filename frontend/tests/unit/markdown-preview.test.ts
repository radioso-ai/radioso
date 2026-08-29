import { describe, expect, it } from 'vitest'

import { stripMarkdownSyntax } from '@/lib/markdown-preview'

describe('stripMarkdownSyntax', () => {
  it('strips links, keeping the link text', () => {
    expect(stripMarkdownSyntax('See [the docs](https://example.com/docs) for details')).toBe(
      'See the docs for details',
    )
  })

  it('strips bold emphasis', () => {
    expect(stripMarkdownSyntax('This is **very** important')).toBe('This is very important')
  })

  it('strips asterisk italics', () => {
    expect(stripMarkdownSyntax('This is *somewhat* important')).toBe('This is somewhat important')
  })

  it('strips underscore emphasis', () => {
    expect(stripMarkdownSyntax('This is _somewhat_ important')).toBe('This is somewhat important')
  })

  it('strips inline code', () => {
    expect(stripMarkdownSyntax('Run `npm install` first')).toBe('Run npm install first')
  })

  it('handles combined markdown in a single preview string', () => {
    expect(stripMarkdownSyntax('Check **this** [link](https://x.test) and `code`')).toBe(
      'Check this link and code',
    )
  })

  it('leaves plain text untouched', () => {
    expect(stripMarkdownSyntax('Disponibilità del libro in inglese')).toBe('Disponibilità del libro in inglese')
  })

  it('returns an empty string unchanged', () => {
    expect(stripMarkdownSyntax('')).toBe('')
  })
})
