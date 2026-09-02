'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'

import { EMPTY_RUNTIME_CONFIG, parseRuntimeConfig, type RuntimeConfig } from '@/lib/runtime-config'

const subscribeBrowserOrigin = () => () => {}
const getBrowserOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin)
const getServerOrigin = () => ''

/** The dashboard origin, stable across server render and hydration. */
export const useDashboardOrigin = (): string =>
  useSyncExternalStore(subscribeBrowserOrigin, getBrowserOrigin, getServerOrigin)

export interface ResolvedRuntimeConfig extends RuntimeConfig {
  /** True once the deployment has answered; its values are then authoritative even when empty. */
  isResolved: boolean
}

/**
 * Deployment values the server resolves at request time. They are read once per mount;
 * a failed read leaves the empty config unresolved, so consumers may fall back to
 * build-time defaults only in that case.
 */
export function useRuntimeConfig(): ResolvedRuntimeConfig {
  const [config, setConfig] = useState<ResolvedRuntimeConfig>({ ...EMPTY_RUNTIME_CONFIG, isResolved: false })

  useEffect(() => {
    const controller = new AbortController()

    void fetch('/runtime-config', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (body !== null) setConfig({ ...parseRuntimeConfig(body), isResolved: true })
      })
      .catch(() => {})

    return () => controller.abort()
  }, [])

  return config
}
