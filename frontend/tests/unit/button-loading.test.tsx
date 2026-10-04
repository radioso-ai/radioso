/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

// Browser page translation, extensions, and password managers replace a
// button's text node with their own element. React still holds the original
// node, so its next insertBefore against that reference throws NotFoundError.
function translateTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    textNodes.push(node as Text)
  }
  for (const node of textNodes) {
    const font = document.createElement('font')
    font.textContent = `translated:${node.data}`
    node.parentNode?.replaceChild(font, node)
  }
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('Button loading', () => {
  let container: HTMLDivElement
  let root: Root
  let uncaught: unknown[]

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    uncaught = []
    root = createRoot(container, {
      onUncaughtError: (error) => {
        uncaught.push(error)
      },
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('reproduces the crash with a conditional spinner beside a bare label', () => {
    const render = (loading: boolean) =>
      act(() => {
        root.render(
          <Button type="submit">
            {loading ? <Spinner /> : null}
            Sign In
          </Button>,
        )
      })

    render(false)
    translateTextNodes(container)

    let thrown: unknown
    try {
      render(true)
    } catch (error) {
      thrown = error
    }
    const failure = (thrown ?? uncaught[0]) as DOMException | undefined
    expect(failure?.name).toBe('NotFoundError')
  })

  it('survives a translated label when the button owns the pending state', () => {
    const render = (loading: boolean) =>
      act(() => {
        root.render(
          <Button type="submit" loading={loading}>
            Sign In
          </Button>,
        )
      })

    render(false)
    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Sign In')
    expect(button?.disabled).toBe(false)
    expect(button?.querySelector('[role="status"]')).toBeNull()

    translateTextNodes(container)
    render(true)

    expect(uncaught).toEqual([])
    const pending = container.querySelector('button')
    expect(pending?.querySelector('[role="status"]')).not.toBeNull()
    expect(pending?.disabled).toBe(true)
    expect(pending?.getAttribute('aria-busy')).toBe('true')
    expect(pending?.textContent).toContain('Sign In')

    render(false)
    expect(uncaught).toEqual([])
    expect(container.querySelector('button')?.querySelector('[role="status"]')).toBeNull()
  })

  it('swaps a leading icon for the spinner while loading, even under a translated label', () => {
    const render = (loading: boolean) =>
      act(() => {
        root.render(
          <Button loading={loading} icon={<svg data-testid="icon" />}>
            Delete
          </Button>,
        )
      })

    render(false)
    expect(container.querySelector('[data-testid="icon"]')).not.toBeNull()

    translateTextNodes(container)
    render(true)

    expect(uncaught).toEqual([])
    expect(container.querySelector('[data-testid="icon"]')).toBeNull()
    expect(container.querySelector('button [role="status"]')).not.toBeNull()

    render(false)
    expect(uncaught).toEqual([])
    expect(container.querySelector('[data-testid="icon"]')).not.toBeNull()
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('keeps an explicitly disabled button disabled once loading ends', () => {
    act(() => {
      root.render(
        <Button loading={false} disabled>
          Save
        </Button>,
      )
    })
    expect(container.querySelector('button')?.disabled).toBe(true)
  })
})
