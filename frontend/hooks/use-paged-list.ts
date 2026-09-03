'use client'

import { useEffect, useState } from 'react'

import { getApiErrorMessage } from '@/lib/api-error'

export interface PagedListState<T> {
  items: T[]
  total: number
  isLoading: boolean
  error: string | null
  refresh: () => void
}

/**
 * One page of a paged list, fenced against its own history. A `null` loader means there is nothing
 * to load yet — no scope, or the viewer lacks the capability. Any response whose request has been
 * superseded (the scope moved on, the page changed, the component unmounted) is dropped instead of
 * applied to the list now on screen, so callers never repeat a generation counter to say that.
 *
 * `load` must be referentially stable for a given request — memoize it with `useCallback` keyed by
 * the scope and page it reads.
 */
export function usePagedList<T>(
  load: (() => Promise<{ items: T[]; total: number }>) | null,
  errorMessage: string,
): PagedListState<T> {
  const [items, setItems] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [isLoading, setIsLoading] = useState(load !== null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let active = true

    const run = async () => {
      if (!load) {
        setItems([])
        setTotal(0)
        setError(null)
        setIsLoading(false)
        return
      }
      setIsLoading(true)
      try {
        const page = await load()
        if (!active) return
        setItems(page.items)
        setTotal(page.total)
        setError(null)
      } catch (loadError) {
        if (!active) return
        setItems([])
        setTotal(0)
        setError(getApiErrorMessage(loadError, errorMessage))
      } finally {
        if (active) setIsLoading(false)
      }
    }

    void run()
    return () => {
      active = false
    }
  }, [load, errorMessage, reloadToken])

  return {
    items,
    total,
    isLoading,
    error,
    refresh: () => setReloadToken((token) => token + 1),
  }
}
