'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'

import { EMPTY_RUNTIME_CONFIG, parseRuntimeConfig, type RuntimeConfig } from '@/lib/runtime-config'

const subscribeBrowserOrigin = () => () => {}
const getBrowserOrigin = () => (typeof window === 'undefined' ? '' : window.location.origin)
const getServerOrigin = () => ''

/** The dashboard origin, stable across server render and hydration. */
export const useDashboardOrigin = (): string =>
  useSyncExternalStore(subscribeBrowserOrigin, getBrowserOrigin, getServerOrigin)

/**
 * Deployment values the server resolves at request time. They are read once per mount;
 * a failed read leaves the empty config, which every consumer treats as "not configured".
 */
export function useRuntimeConfig(): RuntimeConfig {
  const [config, setConfig] = useState<RuntimeConfig>(EMPTY_RUNTIME_CONFIG)

  useEffect(() => {
    const controller = new AbortController()

    void fetch('/runtime-config', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (body !== null) setConfig(parseRuntimeConfig(body))
      })
      .catch(() => {})

    return () => controller.abort()
  }, [])

  return config
}
