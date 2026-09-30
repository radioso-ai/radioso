'use client'

import { createContext, useCallback, useContext, useEffect, useState, type CSSProperties, type ReactNode } from 'react'

interface SunriseOrigin {
  x: number
  y: number
}

type PlaySunrise = (origin?: SunriseOrigin) => void

// The wash is 300px across at rest; its colour runs out at 70% of the radius.
const WASH_SIZE = 300
const WASH_FILL = 0.7
// Long enough to read the greeting once the wash lands at ~1.2s.
const HOLD_MS = 2400
const FADE_MS = 400

const SunriseContext = createContext<PlaySunrise | null>(null)

// Signing in swaps the auth screen for the app's own loading state, so the
// sunrise lives above both: it covers the handoff instead of being unmounted
// by it, and never delays the sign-in work underneath.
export function SunriseProvider({ children }: { children: ReactNode }) {
  const [sunrise, setSunrise] = useState<{ origin: SunriseOrigin; setting: boolean } | null>(null)

  const play = useCallback<PlaySunrise>((origin) => {
    setSunrise({ origin: origin ?? defaultOrigin(), setting: false })
  }, [])

  useEffect(() => {
    if (!sunrise) return
    const timeout = sunrise.setting
      ? setTimeout(() => setSunrise(null), FADE_MS)
      : setTimeout(() => setSunrise((current) => (current ? { ...current, setting: true } : current)), HOLD_MS)
    return () => clearTimeout(timeout)
  }, [sunrise])

  return (
    <SunriseContext.Provider value={play}>
      {children}
      {sunrise ? <SunriseOverlay origin={sunrise.origin} setting={sunrise.setting} /> : null}
    </SunriseContext.Provider>
  )
}

export function useSunrise(): PlaySunrise {
  return useContext(SunriseContext) ?? noop
}

function noop() {}

function defaultOrigin(): SunriseOrigin {
  return { x: window.innerWidth / 2, y: window.innerHeight / 4 }
}

function SunriseOverlay({ origin, setting }: { origin: SunriseOrigin; setting: boolean }) {
  // Scale the wash until its coloured edge clears the farthest corner.
  const reach = Math.max(
    Math.hypot(origin.x, origin.y),
    Math.hypot(window.innerWidth - origin.x, origin.y),
    Math.hypot(origin.x, window.innerHeight - origin.y),
    Math.hypot(window.innerWidth - origin.x, window.innerHeight - origin.y),
  )
  const style = {
    '--sunrise-x': `${origin.x}px`,
    '--sunrise-y': `${origin.y}px`,
    '--sunrise-scale': String(Math.ceil((reach / (WASH_SIZE / 2) / WASH_FILL) * 10) / 10),
  } as CSSProperties

  return (
    <div className="sunrise" data-setting={setting} style={style} role="status" aria-live="polite">
      <div className="sunrise-wash" />
      <div className="sunrise-greeting">
        <p className="sunrise-title">Hello, sunshine</p>
        <p className="sunrise-detail">Getting everything ready…</p>
      </div>
    </div>
  )
}
