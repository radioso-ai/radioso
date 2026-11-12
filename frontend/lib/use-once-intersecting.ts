'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Whether the element has been on screen yet: false until the browser reports it intersecting the
 * viewport, then true for good. The viewport is watched as it is, with no margin, so "seen" means
 * the element was actually in view, not that it was a screen away. Where the browser cannot
 * report intersections, the element counts as seen at once.
 */
export function useOnceIntersecting<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const element = ref.current
    if (seen || !element) {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true)
        observer.disconnect()
      }
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [seen])
  return [ref, seen]
}
