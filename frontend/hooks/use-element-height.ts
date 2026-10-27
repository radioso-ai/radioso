'use client'

import { useCallback, useState } from 'react'

/** Tracks an element's rendered height; 0 while it is not mounted. Attach the returned ref. */
export function useElementHeight<T extends HTMLElement>() {
  const [height, setHeight] = useState(0)
  const ref = useCallback((node: T | null) => {
    if (!node) {
      return
    }
    setHeight(node.offsetHeight)
    if (typeof ResizeObserver === 'undefined') {
      return () => setHeight(0)
    }
    const observer = new ResizeObserver(() => setHeight(node.offsetHeight))
    observer.observe(node)
    return () => {
      observer.disconnect()
      setHeight(0)
    }
  }, [])
  return [ref, height] as const
}
