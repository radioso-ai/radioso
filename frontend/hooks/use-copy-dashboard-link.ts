import { useCallback, useEffect, useRef, useState } from 'react'

import { copyDashboardLink } from '@/lib/copy-dashboard-link'

const COPIED_FEEDBACK_MS = 2000

/**
 * Copies the dashboard link for one keyed item and reports the outcome for that key, so a caller
 * shows feedback only beside the item it copied. `copiedKey` lasts a moment after a copy;
 * `uncopied` holds the URL to show by hand when the page has no clipboard access, until the next
 * successful copy. Nothing is set after unmount.
 */
export function useCopyDashboardLink() {
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [uncopied, setUncopied] = useState<{ key: string; url: string } | null>(null)
  const mounted = useRef(false)
  const latestCopy = useRef(0)
  const feedbackTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (feedbackTimeout.current !== null) clearTimeout(feedbackTimeout.current)
      feedbackTimeout.current = null
    }
  }, [])

  const copy = useCallback(async (key: string, href: string) => {
    const copyId = latestCopy.current + 1
    latestCopy.current = copyId
    const result = await copyDashboardLink(href)
    // A slower earlier copy must not report over a later one.
    if (!mounted.current || copyId !== latestCopy.current) return
    if (feedbackTimeout.current !== null) clearTimeout(feedbackTimeout.current)
    feedbackTimeout.current = null
    if (!result.copied) {
      setCopiedKey(null)
      setUncopied({ key, url: result.url })
      return
    }
    setUncopied(null)
    setCopiedKey(key)
    feedbackTimeout.current = setTimeout(() => {
      feedbackTimeout.current = null
      setCopiedKey(null)
    }, COPIED_FEEDBACK_MS)
  }, [])

  /** Forgets any feedback, as when the operator moves to another view. */
  const reset = useCallback(() => {
    latestCopy.current += 1
    if (feedbackTimeout.current !== null) clearTimeout(feedbackTimeout.current)
    feedbackTimeout.current = null
    setCopiedKey(null)
    setUncopied(null)
  }, [])

  return { copy, copiedKey, uncopied, reset }
}
