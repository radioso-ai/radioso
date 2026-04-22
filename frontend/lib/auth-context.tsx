'use client'

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { clearWorkspaceStorage } from '@/lib/api'

export interface User {
  userId: string
  accountId: string
  email: string
}

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  isBootstrapping: boolean
  login: (email: string, userId: string, accountId: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)
const AUTH_STORAGE_KEY = 'radioso.authUser'
const LAST_ACCOUNT_STORAGE_KEY = 'radioso.lastAccountId'

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

    return {
      userId: parsed.userId,
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : parsed.userId,
      email: parsed.email,
    }
  } catch {
    storage.removeItem(AUTH_STORAGE_KEY)
    if ('removeItem' in storage) {
      storage.removeItem(LAST_ACCOUNT_STORAGE_KEY)
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)

  useEffect(() => {
    const bootstrap = async () => {
      if (typeof window === 'undefined') {
        setIsBootstrapping(false)
        return
      }

      setUser(readStoredAuthUser(window.localStorage))
      setIsBootstrapping(false)
    }

    void bootstrap()
  }, [])

  const login = useCallback(async (email: string, userId: string, accountId: string) => {
    const nextUser = { userId, accountId, email }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextUser))
      window.localStorage.setItem(LAST_ACCOUNT_STORAGE_KEY, accountId)
    }

    setUser(nextUser)
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    if (typeof window !== 'undefined') {
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
        logout
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
