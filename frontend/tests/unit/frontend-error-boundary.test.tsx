/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FrontendErrorBoundaryInner } from '@/components/frontend-error-boundary'
import { CHUNK_RELOAD_PARAM } from '@/lib/chunk-load-recovery'

let shouldThrow = false
let thrown: Error = new Error('render failed')

const ThrowingChild = () => {
  if (shouldThrow) {
    throw thrown
  }
  return <div>Recovered</div>
}

const chunkLoadError = (): Error => {
  const error = new Error('Loading chunk 482 failed.')
  error.name = 'ChunkLoadError'
  return error
}

const dispatchUnhandledRejection = (reason: unknown) => {
  window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason }))
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
    window.history.replaceState({}, '', '/')
    thrown = new Error('render failed')
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

  describe('chunk load failures after a deploy', () => {
    const reporter = () => ({ report: vi.fn().mockResolvedValue(null) })
    const renderBoundary = (props: { reporter: ReturnType<typeof reporter>; reloadFrame: (url: string) => void }) => {
      act(() => {
        root.render(
          <FrontendErrorBoundaryInner resetKey="/embed-frame" {...props}>
            <ThrowingChild />
          </FrontendErrorBoundaryInner>,
        )
      })
    }
    const markedUrl = (reloadFrame: ReturnType<typeof vi.fn>) => new URL(reloadFrame.mock.calls[0]?.[0] as string)

    it('reloads the frame once and reports nothing when a render hits a missing chunk', () => {
      window.history.replaceState({}, '', '/embed-frame?locale=it')
      const reports = reporter()
      const reloadFrame = vi.fn()
      shouldThrow = true
      thrown = chunkLoadError()

      renderBoundary({ reporter: reports, reloadFrame })

      expect(reloadFrame).toHaveBeenCalledTimes(1)
      expect(markedUrl(reloadFrame).pathname).toBe('/embed-frame')
      expect(markedUrl(reloadFrame).searchParams.get('locale')).toBe('it')
      expect(markedUrl(reloadFrame).searchParams.get(CHUNK_RELOAD_PARAM)).not.toBeNull()
      expect(reports.report).not.toHaveBeenCalled()
      expect(container.textContent).not.toContain('Something went wrong')
    })

    it('falls through to the fallback and reports when the reload already happened', () => {
      window.history.replaceState({}, '', `/embed-frame?${CHUNK_RELOAD_PARAM}=${Date.now()}`)
      const reports = reporter()
      const reloadFrame = vi.fn()
      shouldThrow = true
      thrown = chunkLoadError()

      renderBoundary({ reporter: reports, reloadFrame })

      expect(reloadFrame).not.toHaveBeenCalled()
      expect(container.textContent).toContain('Something went wrong')
      expect(reports.report).toHaveBeenCalledWith(expect.objectContaining({
        errorType: 'frontend.react.unhandled',
        error: thrown,
      }))
    })

    it('reports a missing chunk that arrives as an unhandled rejection and leaves the page alone', () => {
      window.history.replaceState({}, '', '/w/acme')
      const reports = reporter()
      const reloadFrame = vi.fn()
      shouldThrow = false
      renderBoundary({ reporter: reports, reloadFrame })

      const error = chunkLoadError()
      dispatchUnhandledRejection(error)

      expect(reloadFrame).not.toHaveBeenCalled()
      expect(reports.report).toHaveBeenCalledWith(expect.objectContaining({
        errorType: 'frontend.promise.unhandled',
        error,
      }))
    })

    it('reports a missing chunk that arrives as a window error and leaves the page alone', () => {
      const reports = reporter()
      const reloadFrame = vi.fn()
      shouldThrow = false
      renderBoundary({ reporter: reports, reloadFrame })

      const error = chunkLoadError()
      window.dispatchEvent(new ErrorEvent('error', { error, message: error.message }))

      expect(reloadFrame).not.toHaveBeenCalled()
      expect(reports.report).toHaveBeenCalledWith(expect.objectContaining({
        errorType: 'frontend.runtime.unhandled',
        error,
      }))
    })

    it('reloads once however many renders hit the missing chunk', () => {
      const reports = reporter()
      const reloadFrame = vi.fn()
      shouldThrow = true
      thrown = chunkLoadError()
      renderBoundary({ reporter: reports, reloadFrame })

      shouldThrow = true
      act(() => {
        root.render(
          <FrontendErrorBoundaryInner resetKey="/embed-frame/next" reporter={reports} reloadFrame={reloadFrame}>
            <ThrowingChild />
          </FrontendErrorBoundaryInner>,
        )
      })

      expect(reloadFrame).toHaveBeenCalledTimes(1)
      expect(reports.report).not.toHaveBeenCalled()
    })

    it('still reports and never reloads for any other failure', () => {
      const reports = reporter()
      const reloadFrame = vi.fn()
      shouldThrow = false
      renderBoundary({ reporter: reports, reloadFrame })

      const error = new TypeError('Failed to fetch')
      dispatchUnhandledRejection(error)

      expect(reloadFrame).not.toHaveBeenCalled()
      expect(reports.report).toHaveBeenCalledWith(expect.objectContaining({
        errorType: 'frontend.promise.unhandled',
        error,
      }))
    })
  })
})
