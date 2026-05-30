/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MarkdownContent } from '@/components/markdown/markdown-content'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

// Regression guard for the embed-widget "links not clickable" bug. The widget
// re-renders on every focusin; if a re-render with fresh (but equivalent)
// callback/trailing props remounts the live <a>, the browser drops the click
// mid-gesture and the link never opens. The anchor DOM node must survive a
// re-render even when onLinkClick / transformLinkHref / trailingInlineContent
// arrive as brand-new references.
describe('MarkdownContent DOM stability across re-renders', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('keeps the same <a> element when callback props change identity', () => {
    const renderWithFreshCallbacks = () => {
      act(() => {
        root.render(
          <MarkdownContent
            variant="chat"
            content="See the [docs](https://example.com/docs)."
            onLinkClick={() => {}}
            transformLinkHref={(href) => href}
            trailingInlineContent={<span>cite</span>}
          />,
        )
      })
    }

    renderWithFreshCallbacks()
    const firstAnchor = container.querySelector('a')
    expect(firstAnchor).not.toBeNull()

    renderWithFreshCallbacks()
    const secondAnchor = container.querySelector('a')

    expect(secondAnchor).toBe(firstAnchor)
  })
})
