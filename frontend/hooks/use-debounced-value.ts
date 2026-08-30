import { useEffect, useState } from 'react'

/**
 * Delays reflecting `value`'s changes by `delayMs`, collapsing rapid updates (e.g.
 * keystrokes in a search box) into one. The returned value always starts equal to the
 * input value, so the first render never waits on the delay.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebounced(value), delayMs)
    return () => window.clearTimeout(timeoutId)
  }, [value, delayMs])

  return debounced
}
