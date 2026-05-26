/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FrontendErrorBoundaryInner } from '@/components/frontend-error-boundary'

let shouldThrow = false

const ThrowingChild = () => {
  if (shouldThrow) {
    throw new Error('render failed')
  }
  return <div>Recovered</div>
}

describe('FrontendErrorBoundaryInner', () => {
  let container: HTMLDivElement
  let root: Root
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
    consoleErrorSpy.mockRestore()
  })

  it('reports render errors and lets the user retry without a full reload', () => {
    const reporter = {
      report: vi.fn().mockResolvedValue(null),
    }
    shouldThrow = true

    act(() => {
      root.render(
        <FrontendErrorBoundaryInner resetKey="/w/acme" reporter={reporter}>
          <ThrowingChild />
        </FrontendErrorBoundaryInner>,
      )
    })

    expect(container.textContent).toContain('Something went wrong')
    expect(reporter.report).toHaveBeenCalledWith(expect.objectContaining({
      errorType: 'frontend.react.unhandled',
      error: expect.any(Error),
    }))

    shouldThrow = false
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(container.textContent).toContain('Recovered')
  })

  it('resets the fallback when the route key changes', () => {
    const reporter = {
      report: vi.fn().mockResolvedValue(null),
    }
    shouldThrow = true

    act(() => {
      root.render(
        <FrontendErrorBoundaryInner resetKey="/w/acme" reporter={reporter}>
          <ThrowingChild />
        </FrontendErrorBoundaryInner>,
      )
    })

    expect(container.textContent).toContain('Something went wrong')

    shouldThrow = false
    act(() => {
      root.render(
        <FrontendErrorBoundaryInner resetKey="/w/acme/settings" reporter={reporter}>
          <ThrowingChild />
        </FrontendErrorBoundaryInner>,
      )
    })

    expect(container.textContent).toContain('Recovered')
  })

  it('uses the provided reporter for mounted window listeners', () => {
    const reporter = {
      report: vi.fn().mockResolvedValue(null),
    }

    act(() => {
      root.render(
        <FrontendErrorBoundaryInner resetKey="/w/acme" reporter={reporter}>
          <div>Ready</div>
        </FrontendErrorBoundaryInner>,
      )
    })

    const error = new Error('runtime failed')
    window.dispatchEvent(new ErrorEvent('error', {
      error,
      message: error.message,
    }))

    expect(reporter.report).toHaveBeenCalledWith(expect.objectContaining({
      error,
      errorType: 'frontend.runtime.unhandled',
      message: 'runtime failed',
    }))
  })
})
