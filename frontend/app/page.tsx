'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/lib/auth-context'
import { AuthPage } from '@/components/auth/auth-page'
import { LogoSpinner, Spinner } from '@/components/ui/spinner'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { getStoredActiveWorkspaceId, getStoredActiveWorkspacePublicRouteKey } from '@/lib/api'

export default function Home() {
  const router = useRouter()
  const { user, isAuthenticated, isBootstrapping } = useAuth()

  useEffect(() => {
    if (!isBootstrapping && user) {
      const workspaceId =
        typeof window !== 'undefined' ? getStoredActiveWorkspaceId() ?? undefined : undefined
      const workspacePublicRouteKey =
        typeof window !== 'undefined' ? getStoredActiveWorkspacePublicRouteKey() ?? undefined : undefined
      router.replace(buildDashboardHref(user.accountId, {
        section: 'chat',
        workspaceId,
        workspacePublicRouteKey,
      }))
    }
  }, [isBootstrapping, router, user])

  if (isBootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <AuthPage />
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <LogoSpinner imageClassName="h-7 w-7" />
    </div>
  )
}
