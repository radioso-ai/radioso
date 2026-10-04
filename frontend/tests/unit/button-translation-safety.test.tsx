/* @vitest-environment jsdom */

// The shared Button and AlertDialogAction primitives used to hand the DOM a bare text node
// whenever a label sat next to a conditionally rendered icon (a spinner that replaces a
// static icon, not just appears next to one). Page translation, browser extensions, and
// password managers re-parent raw text nodes (Google Translate wraps them in <font> tags).
// React keeps its own reference to the original node; the next render that needs to
// insertBefore/removeChild relative to that reference throws `NotFoundError`, which the
// frontend error boundary turns into the generic failure screen. Issue #1293's original
// repro (a spinner appearing next to a static "Sign In" label) was fixed call site by call
// site; these tests reproduce the same crash against an icon-swap shape (Loader2 replacing
// RefreshCw) that the call-site patches never touched, to prove the fix now lives in the
// shared primitives instead.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Loader2, RefreshCw } from 'lucide-react'

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

describe('Button survives translation re-parenting next to a toggling icon', () => {
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

  function RefreshButton() {
    const [refreshing, setRefreshing] = useState(false)
    return (
      <Button type="button" onClick={() => setRefreshing(true)}>
        {refreshing ? <Loader2 data-testid="spinner" className="mr-2 h-4 w-4" /> : <RefreshCw data-testid="idle-icon" className="mr-2 h-4 w-4" />}
        Refresh tools
      </Button>
    )
  }

  it('swaps the icon without throwing when the label text node was re-parented', async () => {
    await act(async () => {
      root.render(<RefreshButton />)
    })

    const button = container.querySelector('button')!
    wrapFirstTextNodeLikeTranslation(button)

    let threw: unknown = null
    await act(async () => {
      try {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      } catch (error) {
        threw = error
      }
    })

    expect(threw).toBeNull()
    expect(button.querySelector('[data-testid="spinner"]')).toBeTruthy()
    expect(button.textContent).toContain('Refresh tools')
  })
})

describe('AlertDialogAction survives translation re-parenting next to a toggling spinner', () => {
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

  function RotateAction() {
    const [rotating, setRotating] = useState(false)
    return (
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Rotate token</AlertDialogTitle>
          <AlertDialogDescription>Issue a new token and revoke the old one.</AlertDialogDescription>
          <AlertDialogAction onClick={() => setRotating(true)}>
            {rotating ? <Loader2 data-testid="spinner" className="mr-2 h-4 w-4" /> : <RefreshCw data-testid="idle-icon" className="mr-2 h-4 w-4" />}
            Rotate token
          </AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    )
  }

  it('swaps the icon without throwing when the label text node was re-parented', async () => {
    await act(async () => {
      root.render(<RotateAction />)
    })

    // AlertDialogContent renders through a Radix Portal into document.body, not `container`.
    const action = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Rotate token'))!
    wrapFirstTextNodeLikeTranslation(action)

    let threw: unknown = null
    await act(async () => {
      try {
        action.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      } catch (error) {
        threw = error
      }
    })

    expect(threw).toBeNull()
    expect(action.querySelector('[data-testid="spinner"]')).toBeTruthy()
  })
})
