'use client'

import { Moon, Sun } from 'lucide-react'
import Image from 'next/image'
import { createContext, useCallback, useContext, useRef, useState, type ReactNode, type RefObject } from 'react'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { useSunrise } from './sunrise'

const SunContext = createContext<RefObject<HTMLDivElement | null> | null>(null)
// Rapid presses keep the newest few waves rather than stacking without bound.
const MAX_PINGS = 6

interface AuthShellProps {
  title: string
  subtitle?: string
  footer?: ReactNode
  children: ReactNode
}

// The signed-out screens: the sun mark broadcasting over a dotted field, and
// the form on a card lit from above. The sun answers the form it sits over —
// see `.auth-band:has(...)` in globals.css. The controls inside are the shared
// primitives, themed only through the band's re-scoped tokens.
export function AuthShell({ title, subtitle, footer, children }: AuthShellProps) {
  const sunRef = useRef<HTMLDivElement>(null)

  return (
    <SunContext.Provider value={sunRef}>
      <div className="auth-band relative isolate flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 py-12 text-foreground">
        <AuthThemeToggle />
        <div className="relative flex flex-col items-center">
          <AuthSun sunRef={sunRef} />
          <Image
            src="/radioso-wordmark.svg"
            alt="radioso"
            width={94}
            height={20}
            className="mt-3.5 h-5 w-auto dark:hidden"
            priority
          />
          <Image
            src="/radioso-wordmark-dark.svg"
            alt="radioso"
            width={94}
            height={20}
            className="mt-3.5 hidden h-5 w-auto dark:block"
            priority
          />
        </div>
        <h1 className="mt-10 text-balance text-center text-4xl font-medium tracking-tight sm:text-5xl">
          {title}
        </h1>
        {subtitle ? <p className="mt-3 text-center text-base text-muted-foreground">{subtitle}</p> : null}
        <div className="auth-card mt-8 flex w-full max-w-sm flex-col gap-4 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm backdrop-blur-md">
          {children}
        </div>
        {footer ? <div className="mt-6 text-center text-sm text-muted-foreground">{footer}</div> : null}
      </div>
    </SunContext.Provider>
  )
}

// Pressing the sun sends one more wave out after the steady three. Without
// motion there is nothing to send, since a wave is its animation.
function AuthSun({ sunRef }: { sunRef: RefObject<HTMLDivElement | null> }) {
  const [pings, setPings] = useState<number[]>([])
  const nextPing = useRef(0)

  const ping = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const id = nextPing.current++
    setPings((current) => [...current.slice(-(MAX_PINGS - 1)), id])
  }

  return (
    <>
      <div aria-hidden className="auth-signal">
        <div className="auth-dots" />
        <div className="auth-glow" />
        <div className="auth-rings">
          <span />
          <span />
          <span />
        </div>
        {pings.map((id) => (
          <span
            key={id}
            className="auth-ping"
            onAnimationEnd={() => setPings((current) => current.filter((ping) => ping !== id))}
          />
        ))}
      </div>
      <div ref={sunRef} className="auth-sun" onPointerDown={ping}>
        <Image src="/radioso-icon.svg" alt="" width={104} height={104} priority draggable={false} />
      </div>
    </>
  )
}

// Plays the sign-in sunrise from the sun mark. Call it once the credentials
// are accepted, right before handing the session to the app.
export function useAuthSunrise() {
  const play = useSunrise()
  const sunRef = useContext(SunContext)

  return useCallback(() => {
    const rect = sunRef?.current?.getBoundingClientRect()
    play(rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : undefined)
  }, [play, sunRef])
}

// Icons swap on the `dark` class rather than on resolvedTheme, so the server
// render and the first client render agree before the stored theme is read.
function AuthThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Toggle dark mode"
      className="absolute top-4 right-4 text-muted-foreground"
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Moon className="dark:hidden" />
      <Sun className="hidden dark:block" />
    </Button>
  )
}
