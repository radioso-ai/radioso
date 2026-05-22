import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  MarkdownContent,
  isSafeHref,
  shouldHandleMarkdownLinkClick,
  shouldNavigateMarkdownLinkFromEmbed,
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

describe('shouldHandleMarkdownLinkClick', () => {
  const primaryClick = {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  }

  it('handles only unmodified primary-button clicks', () => {
    expect(shouldHandleMarkdownLinkClick(primaryClick)).toBe(true)
    expect(shouldHandleMarkdownLinkClick({ ...primaryClick, button: 1 })).toBe(false)
    expect(shouldHandleMarkdownLinkClick({ ...primaryClick, metaKey: true })).toBe(false)
    expect(shouldHandleMarkdownLinkClick({ ...primaryClick, ctrlKey: true })).toBe(false)
    expect(shouldHandleMarkdownLinkClick({ ...primaryClick, shiftKey: true })).toBe(false)
    expect(shouldHandleMarkdownLinkClick({ ...primaryClick, altKey: true })).toBe(false)
    expect(shouldHandleMarkdownLinkClick({ ...primaryClick, defaultPrevented: true })).toBe(false)
  })
})

describe('shouldNavigateMarkdownLinkFromEmbed', () => {
  it('top-navigates links only from framed embedded chat pages', () => {
    expect(shouldNavigateMarkdownLinkFromEmbed({
      isFramed: true,
      pathname: '/embed/embed-token',
      href: 'https://example.com/docs',
      baseUrl: 'https://app.example.com/embed/embed-token',
    })).toBe(true)

    expect(shouldNavigateMarkdownLinkFromEmbed({
      isFramed: false,
      pathname: '/embed/embed-token',
      href: 'https://example.com/docs',
      baseUrl: 'https://app.example.com/embed/embed-token',
    })).toBe(false)

    expect(shouldNavigateMarkdownLinkFromEmbed({
      isFramed: true,
      pathname: '/chat/public-token',
      href: 'https://example.com/docs',
      baseUrl: 'https://app.example.com/chat/public-token',
    })).toBe(false)
  })

  it('lets mailto links use default browser handling in embedded chat pages', () => {
    expect(shouldNavigateMarkdownLinkFromEmbed({
      isFramed: true,
      pathname: '/embed/embed-token',
      href: 'mailto:hi@example.com',
      baseUrl: 'https://app.example.com/embed/embed-token',
    })).toBe(false)
  })

  it('lets hash-only links use default browser handling in embedded chat pages', () => {
    expect(shouldNavigateMarkdownLinkFromEmbed({
      isFramed: true,
      pathname: '/embed/embed-token',
      href: '#section',
      baseUrl: 'https://app.example.com/embed/embed-token',
    })).toBe(false)
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
