'use client'

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { clearWorkspaceStorage } from '@/lib/api'

interface User {
  userId: string
  email: string
}

interface AuthContextType {
  user: User | null
  isAuthenticated: boolean
  isBootstrapping: boolean
  login: (email: string, userId: string) => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthContextType | null>(null)
const AUTH_STORAGE_KEY = 'radioso.authUser'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isBootstrapping, setIsBootstrapping] = useState(true)

  useEffect(() => {
    const bootstrap = async () => {
      if (typeof window === 'undefined') {
        setIsBootstrapping(false)
        return
      }

      const storedUser = window.localStorage.getItem(AUTH_STORAGE_KEY)
      if (!storedUser) {
        setIsBootstrapping(false)
        return
      }

      try {
        const parsedUser = JSON.parse(storedUser) as User
        setUser(parsedUser)
      } catch {
        window.localStorage.removeItem(AUTH_STORAGE_KEY)
        clearWorkspaceStorage()
      } finally {
        setIsBootstrapping(false)
      }
    }

    void bootstrap()
  }, [])

  const login = useCallback(async (email: string, userId: string) => {
    const nextUser = { userId, email }
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextUser))
    }

    setUser(nextUser)
  }, [])

  const logout = useCallback(() => {
    setUser(null)
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
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
