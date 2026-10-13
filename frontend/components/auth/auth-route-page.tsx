'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/lib/auth-context'
import { LogoSpinner } from '@/components/ui/spinner'
import { normalizeSameOriginReturnPath } from '@/lib/auth-return-url'
import { AuthPage, type AuthMode } from './auth-page'

export function AuthRoutePage({ mode, returnTo }: { mode: AuthMode; returnTo?: string }) {
  const router = useRouter()
  const { isAuthenticated, isBootstrapping } = useAuth()
  const normalizedReturnTo = normalizeSameOriginReturnPath(returnTo)

  useEffect(() => {
    if (!isBootstrapping && isAuthenticated) {
      router.replace(normalizedReturnTo ?? '/')
    }
  }, [isAuthenticated, isBootstrapping, normalizedReturnTo, router])

  if (isBootstrapping || isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  return <AuthPage mode={mode} returnTo={returnTo} />
}
