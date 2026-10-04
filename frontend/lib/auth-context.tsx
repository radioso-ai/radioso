'use client'

import { createContext, useContext, useEffect, useRef, useState, useCallback, ReactNode } from 'react'
import { authApi, clearWorkspaceStorage, seedWorkspaceSession } from '@/lib/api'

interface User {
  userId: string
  accountId: string
  email: string
  /** The name the person chose: null when they have none, absent until the server has said. */
  displayName?: string | null
  organizationName?: string
}

/** Who just signed in, as every sign-in response describes them. */
interface SignedInUser {
  email: string
  userId: string
  accountId: string
  organizationName?: string | null
  displayName: string | null
}

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  isBootstrapping: boolean
  login: (signedIn: SignedInUser) => Promise<void>
  logout: () => void
  setDisplayName: (displayName: string | null) => void
}

const AuthContext = createContext<AuthContextType | null>(null)
const AUTH_STORAGE_KEY = 'radioso.authUser'
const LAST_ACCOUNT_STORAGE_KEY = 'radioso.lastAccountId'
const ORGANIZATION_NAME_CACHE_KEY = 'radioso.accountOrganizationNames'

const normalizeStoredOrganizationName = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed || undefined
}

const normalizeDisplayName = (value: unknown): string | null | undefined => {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string') {
    return undefined
  }

  return value.trim() || null
}

const readStoredAccountOrganizationNames = (
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
): Record<string, string> => {
  if (!storage) {
    return {}
  }

  const storedNames = storage.getItem(ORGANIZATION_NAME_CACHE_KEY)
  if (!storedNames) {
    return {}
  }

  try {
    const parsed = JSON.parse(storedNames) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid organization name cache')
    }

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([accountId, organizationName]) => [accountId, normalizeStoredOrganizationName(organizationName)] as const)
        .filter((entry): entry is [string, string] => Boolean(entry[1])),
    )
  } catch {
    storage.removeItem(ORGANIZATION_NAME_CACHE_KEY)
    return {}
  }
}

export const storeAccountOrganizationName = (
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null,
  accountId: string,
  organizationName: string | null | undefined,
) => {
  const normalizedName = normalizeStoredOrganizationName(organizationName)
  if (!storage || !accountId || !normalizedName) {
    return
  }

  const nextNames = {
    ...readStoredAccountOrganizationNames(storage),
    [accountId]: normalizedName,
  }
  storage.setItem(ORGANIZATION_NAME_CACHE_KEY, JSON.stringify(nextNames))
}

export const mergeStoredAccountOrganizationNames = <T extends { accountId: string; organizationName: string }>(
  accounts: T[],
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
): T[] => {
  const storedNames = readStoredAccountOrganizationNames(storage)
  const nameCounts = accounts.reduce<Record<string, number>>((counts, account) => {
    const normalizedName = account.organizationName.trim().toLowerCase()
    counts[normalizedName] = (counts[normalizedName] ?? 0) + 1
    return counts
  }, {})

  return accounts.map((account) => {
    const storedName = storedNames[account.accountId]
    const isAmbiguousName = nameCounts[account.organizationName.trim().toLowerCase()] > 1
    return isAmbiguousName && storedName && storedName !== account.organizationName
      ? { ...account, organizationName: storedName }
      : account
  })
}

export const readStoredAuthUser = (
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
): User | null => {
  if (!storage) {
    return null
  }

  const storedUser = storage.getItem(AUTH_STORAGE_KEY)
  if (!storedUser) {
    return null
  }

  try {
    const parsed = JSON.parse(storedUser) as Partial<User>
    if (typeof parsed.userId !== 'string' || typeof parsed.email !== 'string') {
      throw new Error('Invalid auth bootstrap data')
    }

    const organizationName = normalizeStoredOrganizationName(parsed.organizationName)
    const displayName = normalizeDisplayName(parsed.displayName)
    return {
      userId: parsed.userId,
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : parsed.userId,
      email: parsed.email,
      ...(displayName !== undefined ? { displayName } : {}),
      ...(organizationName ? { organizationName } : {}),
    }
  } catch {
    storage.removeItem(AUTH_STORAGE_KEY)
    if ('removeItem' in storage) {
      storage.removeItem(LAST_ACCOUNT_STORAGE_KEY)
      storage.removeItem(ORGANIZATION_NAME_CACHE_KEY)
    }
    clearWorkspaceStorage()
    return null
  }
}

export const getStoredLastAccountId = (
  storage: Pick<Storage, 'getItem'> | null,
): string | null => {
  if (!storage) {
    return null
  }

  const value = storage.getItem(LAST_ACCOUNT_STORAGE_KEY)
  return typeof value === 'string' && value.trim() ? value : null
}

const persistAuthUser = (
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  user: User,
): void => {
  storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user))
  storage.setItem(LAST_ACCOUNT_STORAGE_KEY, user.accountId)
  storeAccountOrganizationName(storage, user.accountId, user.organizationName ?? null)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)
  // The latest user, for callbacks that must read it without being re-created on every change.
  const userRef = useRef<User | null>(null)

  // The one path a changed user takes: stored first, so a navigation that
  // follows at once still finds it, then shown.
  const commitUser = useCallback((nextUser: User) => {
    userRef.current = nextUser
    if (typeof window !== 'undefined') {
      persistAuthUser(window.localStorage, nextUser)
    }
    setUser(nextUser)
  }, [])

  useEffect(() => {
    let active = true

    const bootstrap = async () => {
      if (typeof window === 'undefined') {
        setIsBootstrapping(false)
        return
      }

      const storedUser = readStoredAuthUser(window.localStorage)
      if (storedUser) {
        userRef.current = storedUser
        setUser(storedUser)
        setIsBootstrapping(false)
        return
      }

      // Local state is empty but a session cookie may still be live: a sign-in
      // that redirects the browser — provider OAuth — sets the cookie and never
      // runs `login()`. Asking the server who we are is what turns that cookie
      // into a signed-in app, instead of showing the sign-in form again.
      const session = await authApi.getCurrentSession()
      if (!active) return
      if (session) {
        const organizationName = normalizeStoredOrganizationName(session.organizationName)
        seedWorkspaceSession(session.workspaceId, session.workspacePublicRouteKey)
        commitUser({
          userId: session.userId,
          accountId: session.accountId,
          email: session.email,
          displayName: normalizeDisplayName(session.displayName) ?? null,
          ...(organizationName ? { organizationName } : {}),
        })
      }
      setIsBootstrapping(false)
    }

    void bootstrap()

    return () => {
      active = false
    }
  }, [commitUser])

  // A user stored before names existed carries none, so the session is asked
  // once in the background. Every sign-in response carries the name itself.
  const userAwaitingDisplayName = user && user.displayName === undefined ? user.userId : null
  useEffect(() => {
    if (!userAwaitingDisplayName) {
      return
    }

    let active = true
    void authApi.getCurrentSession().then((session) => {
      const current = userRef.current
      if (!active || session?.userId !== userAwaitingDisplayName) return
      if (current?.userId !== userAwaitingDisplayName || current.displayName !== undefined) return
      commitUser({ ...current, displayName: normalizeDisplayName(session.displayName) ?? null })
    })

    return () => {
      active = false
    }
  }, [commitUser, userAwaitingDisplayName])

  const login = useCallback(async ({ email, userId, accountId, organizationName, displayName }: SignedInUser) => {
    const normalizedOrganizationName = normalizeStoredOrganizationName(organizationName)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('radioso:auth-session-ended'))
    }
    commitUser({
      userId,
      accountId,
      email,
      displayName: normalizeDisplayName(displayName),
      ...(normalizedOrganizationName ? { organizationName: normalizedOrganizationName } : {}),
    })
  }, [commitUser])

  const setDisplayName = useCallback((displayName: string | null) => {
    const current = userRef.current
    if (current && current.displayName !== displayName) {
      commitUser({ ...current, displayName })
    }
  }, [commitUser])

  const logout = useCallback(() => {
    userRef.current = null
    setUser(null)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('radioso:auth-session-ended'))
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
      window.localStorage.removeItem(LAST_ACCOUNT_STORAGE_KEY)
    }
    clearWorkspaceStorage()
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: user !== null,
        isBootstrapping,
        login,
        logout,
        setDisplayName,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

export function useOptionalAuth() {
  return useContext(AuthContext)
}
