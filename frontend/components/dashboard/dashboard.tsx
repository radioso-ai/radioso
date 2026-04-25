'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { LogoSpinner } from '@/components/ui/spinner'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardHref } from '@/lib/dashboard-routes'
import { getStoredActiveWorkspaceId, getStoredActiveWorkspacePublicRouteKey } from '@/lib/api'

export function Dashboard() {
  const router = useRouter()
  const { user, isBootstrapping } = useAuth()

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

  return (
    <div className="flex min-h-screen items-center justify-center">
      <LogoSpinner imageClassName="h-7 w-7" />
    </div>
  )
}
