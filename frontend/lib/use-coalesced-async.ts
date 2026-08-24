'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Runs at most one operation at a time and retains only the newest queued call.
 * This keeps polling and push invalidations lossy-but-convergent under a slow API.
 */
export const useCoalescedAsync = <Args extends unknown[]>(
  operation: (...args: Args) => Promise<void>,
): ((...args: Args) => Promise<void>) => {
  const operationRef = useRef(operation)
  useEffect(() => {
    operationRef.current = operation
  }, [operation])
  const runningRef = useRef<Promise<void> | null>(null)
  const queuedArgsRef = useRef<Args | null>(null)

  return useCallback((...args: Args): Promise<void> => {
    if (runningRef.current) {
      queuedArgsRef.current = args
      return runningRef.current
    }

    const drain = async () => {
      let nextArgs: Args | null = args
      while (nextArgs) {
        queuedArgsRef.current = null
        await operationRef.current(...nextArgs)
        nextArgs = queuedArgsRef.current
      }
    }

    const running = drain().finally(() => {
      if (runningRef.current === running) {
        runningRef.current = null
      }
    })
    runningRef.current = running
    return running
  }, [])
}
