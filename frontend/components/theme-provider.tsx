'use client'

import * as React from 'react'

export type Theme = 'light' | 'dark' | 'system'

export interface ThemeProviderProps {
  attribute?: 'class' | `data-${string}`
  children: React.ReactNode
  defaultTheme?: Theme
  disableTransitionOnChange?: boolean
  enableSystem?: boolean
  storageKey?: string
}

interface ThemeContextValue {
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
  systemTheme?: 'light' | 'dark'
  theme: Theme
}

const DEFAULT_STORAGE_KEY = 'theme'
const ThemeContext = React.createContext<ThemeContextValue | null>(null)
const useIsomorphicLayoutEffect =
  typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

const isTheme = (value: string | null | undefined, enableSystem: boolean): value is Theme => {
  if (value === 'light' || value === 'dark') {
    return true
  }

  return enableSystem && value === 'system'
}

const getSystemTheme = () =>
  window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

const getDefaultTheme = (defaultTheme: Theme, enableSystem: boolean): Theme => {
  if (enableSystem) {
    return defaultTheme
  }

  return defaultTheme === 'system' ? 'light' : defaultTheme
}

const readStoredTheme = (storageKey: string, enableSystem: boolean, fallbackTheme: Theme): Theme => {
  if (typeof window === 'undefined') {
    return fallbackTheme
  }

  try {
    const storedTheme = window.localStorage.getItem(storageKey)
    return isTheme(storedTheme, enableSystem) ? storedTheme : fallbackTheme
  } catch {
    return fallbackTheme
  }
}

const applyThemeAttribute = (attribute: ThemeProviderProps['attribute'], resolvedTheme: 'light' | 'dark') => {
  const root = document.documentElement

  if (attribute === 'class') {
    root.classList.toggle('dark', resolvedTheme === 'dark')
  } else {
    root.setAttribute(attribute ?? 'class', resolvedTheme)
  }

  root.style.colorScheme = resolvedTheme
}

const temporarilyDisableTransitions = () => {
  const style = document.createElement('style')
  style.appendChild(
    document.createTextNode(
      '*{transition:none!important;-webkit-transition:none!important;animation:none!important}',
    ),
  )
  document.head.appendChild(style)

  return () => {
    void window.getComputedStyle(document.body)
    window.requestAnimationFrame(() => {
      style.remove()
    })
  }
}

export function ThemeProvider({
  attribute = 'class',
  children,
  defaultTheme = 'system',
  disableTransitionOnChange = false,
  enableSystem = true,
  storageKey = DEFAULT_STORAGE_KEY,
}: ThemeProviderProps) {
  const fallbackTheme = React.useMemo(
    () => getDefaultTheme(defaultTheme, enableSystem),
    [defaultTheme, enableSystem],
  )
  const [theme, setThemeState] = React.useState<Theme>(() =>
    readStoredTheme(storageKey, enableSystem, fallbackTheme),
  )
  const [systemTheme, setSystemTheme] = React.useState<'light' | 'dark'>(() =>
    typeof window === 'undefined' ? 'light' : getSystemTheme(),
  )

  useIsomorphicLayoutEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemThemeChange = () => {
      setSystemTheme(mediaQuery.matches ? 'dark' : 'light')
    }

    setThemeState(readStoredTheme(storageKey, enableSystem, fallbackTheme))
    handleSystemThemeChange()

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleSystemThemeChange)
      return () => mediaQuery.removeEventListener('change', handleSystemThemeChange)
    }

    mediaQuery.addListener(handleSystemThemeChange)
    return () => mediaQuery.removeListener(handleSystemThemeChange)
  }, [enableSystem, fallbackTheme, storageKey])

  const resolvedTheme = theme === 'system' ? systemTheme : theme

  useIsomorphicLayoutEffect(() => {
    if (typeof document === 'undefined') {
      return
    }

    const restoreTransitions = disableTransitionOnChange ? temporarilyDisableTransitions() : null
    applyThemeAttribute(attribute, resolvedTheme)
    restoreTransitions?.()
  }, [attribute, disableTransitionOnChange, resolvedTheme])

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      const normalizedTheme = isTheme(nextTheme, enableSystem) ? nextTheme : fallbackTheme
      setThemeState(normalizedTheme)

      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(storageKey, normalizedTheme)
        } catch {
          // Ignore storage write failures and keep the in-memory theme state.
        }
      }
    },
    [enableSystem, fallbackTheme, storageKey],
  )

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      resolvedTheme,
      setTheme,
      systemTheme: enableSystem ? systemTheme : undefined,
      theme,
    }),
    [enableSystem, resolvedTheme, setTheme, systemTheme, theme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = React.useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within ThemeProvider')
  }

  return context
}
