'use client'

import { useEffect, useState } from 'react'

import { settingsApi } from '@/lib/api'
import type { EmbeddingCoverage } from '@/lib/api-types'

const DEFAULT_POLL_INTERVAL_MS = 20_000

/**
 * Refreshes canonical embedding coverage while indexing may still be moving.
 * Failed supplementary reads stay hidden, but retry because a transient outage
 * must not permanently remove operator visibility.
 */
export function useEmbeddingCoverage(
  embeddingModel: string,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
): EmbeddingCoverage | null {
  const [coverage, setCoverage] = useState<EmbeddingCoverage | null>(null)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const scheduleNext = () => {
      if (active) {
        timer = setTimeout(() => void poll(), intervalMs)
      }
    }

    const poll = async () => {
      try {
        const next = await settingsApi.getEmbeddingCoverage()
        if (!active) return
        setCoverage(next)
        if (next.missingChunks > 0) scheduleNext()
      } catch {
        if (!active) return
        setCoverage(null)
        scheduleNext()
      }
    }

    void poll()
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [embeddingModel, intervalMs])

  return coverage
}
