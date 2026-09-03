'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import { EMPTY_RUNTIME_CONFIG, parseRuntimeConfig, type RuntimeConfig } from '@/lib/runtime-config'

const subscribeBrowserOrigin = () => () => {}
const getBrowserOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin)
const getServerOrigin = () => ''
const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError'

/** The dashboard origin, stable across server render and hydration. */
export const useDashboardOrigin = (): string =>
  useSyncExternalStore(subscribeBrowserOrigin, getBrowserOrigin, getServerOrigin)

export interface ResolvedRuntimeConfig extends RuntimeConfig {
  /** True once the deployment has answered; its values are then authoritative even when empty. */
  isResolved: boolean
  status: 'failed' | 'loading' | 'resolved'
  retry: () => void
}

const LOADING_CONFIG: Omit<ResolvedRuntimeConfig, 'retry'> = {
  ...EMPTY_RUNTIME_CONFIG,
  isResolved: false,
  status: 'loading',
}

/**
 * Deployment values the server resolves at request time. They are read once per mount;
 * a failed read stays distinct from an authoritative empty config so consumers can
 * render a retryable unavailable state without exposing actions from stale guesses.
 */
export function useRuntimeConfig(): ResolvedRuntimeConfig {
  const [reloadToken, setReloadToken] = useState(0)
  const [config, setConfig] = useState<Omit<ResolvedRuntimeConfig, 'retry'>>(LOADING_CONFIG)
  const retry = useCallback(() => {
    setConfig(LOADING_CONFIG)
    setReloadToken((token) => token + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    void fetch('/runtime-config', { cache: 'no-store', signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Runtime config request failed with ${response.status}`)
        return response.json()
      })
      .then((body: unknown) => {
        setConfig({ ...parseRuntimeConfig(body), isResolved: true, status: 'resolved' })
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) setConfig({ ...EMPTY_RUNTIME_CONFIG, isResolved: false, status: 'failed' })
      })

    return () => controller.abort()
  }, [reloadToken])

  return { ...config, retry }
}
