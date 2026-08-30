/* @vitest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDebouncedValue } from '@/hooks/use-debounced-value'

function renderDebouncedValue<T>(initialValue: T, delayMs: number) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let latest: T = initialValue

  function Harness({ value }: { value: T }) {
    latest = useDebouncedValue(value, delayMs)
    return null
  }

  act(() => {
    root.render(<Harness value={initialValue} />)
  })

  return {
    get current() {
      return latest
    },
    setValue(value: T) {
      act(() => {
        root.render(<Harness value={value} />)
      })
    },
  }
}

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the initial value immediately, before any delay elapses', () => {
    const debounced = renderDebouncedValue('first', 300)
    expect(debounced.current).toBe('first')
  })

  it('does not reflect a change until the delay elapses', () => {
    const debounced = renderDebouncedValue('first', 300)

    debounced.setValue('second')
    expect(debounced.current).toBe('first')

    act(() => {
      vi.advanceTimersByTime(299)
    })
    expect(debounced.current).toBe('first')

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(debounced.current).toBe('second')
  })

  it('collapses rapid successive changes into the last value once the delay elapses', () => {
    const debounced = renderDebouncedValue('f', 300)

    debounced.setValue('fi')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    debounced.setValue('fir')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    debounced.setValue('firs')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    // Only 100ms have elapsed since the last keystroke — still debouncing.
    expect(debounced.current).toBe('f')

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(debounced.current).toBe('firs')
  })
})
