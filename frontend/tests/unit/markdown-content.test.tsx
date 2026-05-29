import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  MarkdownContent,
  isSafeHref,
} from '@/components/markdown/markdown-content'

describe('isSafeHref', () => {
  it('accepts relative, hash, http, https, and mailto links', () => {
    expect(isSafeHref('/docs')).toBe(true)
    expect(isSafeHref('#section')).toBe(true)
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
    expect(isSafeHref('mailto:hi@example.com')).toBe(true)
  })

  it('rejects javascript:, data:, and other unsafe protocols', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,<script>')).toBe(false)
    expect(isSafeHref('file:///etc/passwd')).toBe(false)
    expect(isSafeHref(undefined)).toBe(false)
    expect(isSafeHref('')).toBe(false)
  })
})

describe('MarkdownContent link rendering', () => {
  it('renders safe http links with target="_blank" and noopener', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent variant="chat" content="[docs](https://example.com/docs)" />,
    )

    expect(html).toContain('href="https://example.com/docs"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener"')
  })

  it('supports a safe link href transform', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        variant="chat"
        content="[docs](https://example.com/docs)"
        transformLinkHref={(href) => `${href}?utm_source=radioso`}
      />,
    )

    expect(html).toContain('href="https://example.com/docs?utm_source=radioso"')
  })

  it('strips unsafe links and falls back to plain text', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent variant="chat" content="[evil](javascript:alert(1))" />,
    )

    expect(html).not.toContain('<a')
    expect(html).toContain('evil')
  })
})

describe('MarkdownContent image safety', () => {
  it('strips images with unsafe protocols and falls back to alt text', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        variant="document"
        content={'![evil](javascript:alert("xss"))'}
      />,
    )

    expect(html).not.toContain('<img')
    expect(html).toContain('evil')
  })

  it('suppresses images entirely in chat variant', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        variant="chat"
        content={'![pixel](https://example.com/img.png)'}
      />,
    )

    expect(html).not.toContain('<img')
  })
})
