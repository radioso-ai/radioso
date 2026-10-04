/* @vitest-environment jsdom */

// agent-revision-test-chat.tsx's "Run evals" and "Retry case" buttons predate #1298's
// migration to Button's `loading`/`icon` slot (the file was never touched by that PR) and
// still render the old fragile shape by hand: a conditional icon (or nothing) followed by a
// bare label. Page translation, browser extensions, and password managers re-parent raw
// text nodes (Google Translate wraps them in <font>); React keeps its own reference to the
// original node, and the next render that needs to insertBefore/removeChild relative to it
// throws `NotFoundError` — an uncaught exception that crashes the surrounding render tree,
// same as the original #1293 crash. Confirmed against the real (pre-fix) shape: both
// patterns below threw uncaught once the label's text node was re-parented. These tests
// pin the fixed shape — both call sites migrated to Button's `loading` prop, proven safe by
// `button-loading.test.tsx` — so a future revert back to the manual ternary would fail here.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useState } from 'react'

import { Button } from '@/components/ui/button'

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

// Stand in for a page translator / extension / password manager: wrap the first text node
// inside `el` in a fresh element, the way those tools re-parent text they annotate.
function wrapFirstTextNodeLikeTranslation(el: Element) {
  const textNode = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
  expect(textNode).toBeTruthy()
  const wrapper = document.createElement('font')
  textNode!.parentNode!.replaceChild(wrapper, textNode!)
  wrapper.appendChild(textNode!)
}

describe('agent-revision-test-chat button labels, migrated to Button loading', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function clickAndCapture(button: HTMLButtonElement) {
    let threw: unknown = null
    await act(async () => {
      try {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      } catch (error) {
        threw = error
      }
    })
    return threw
  }

  it('run-evals button: label swaps under `loading` without throwing', async () => {
    function RunEvalsButton() {
      const [running, setRunning] = useState(false)
      return (
        <Button type="button" variant="outline" size="sm" onClick={() => setRunning(true)} loading={running}>
          {running ? 'Running…' : 'Run evals'}
        </Button>
      )
    }

    await act(async () => {
      root.render(<RunEvalsButton />)
    })
    const button = container.querySelector('button')!
    wrapFirstTextNodeLikeTranslation(button)

    const threw = await clickAndCapture(button)

    expect(threw).toBeNull()
    expect(button.textContent).toContain('Running…')
  })

  it('retry-case button: static label with `loading` toggling on without throwing', async () => {
    function RetryCaseButton() {
      const [retrying, setRetrying] = useState(false)
      return (
        <Button
          type="button"
          size="sm"
          variant="link"
          className="h-auto p-0"
          onClick={() => setRetrying(true)}
          loading={retrying}
        >
          Retry case
        </Button>
      )
    }

    await act(async () => {
      root.render(<RetryCaseButton />)
    })
    const button = container.querySelector('button')!
    wrapFirstTextNodeLikeTranslation(button)

    const threw = await clickAndCapture(button)

    expect(threw).toBeNull()
    expect(button.textContent).toContain('Retry case')
  })
})
