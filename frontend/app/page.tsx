'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { useAuth } from '@/lib/auth-context'
import { AuthPage } from '@/components/auth/auth-page'
import { LogoSpinner } from '@/components/ui/spinner'
import { getHomeDashboardRedirectHref } from '@/lib/home-dashboard-redirect'
import { useWorkspace } from '@/lib/workspace-context'

export default function Home() {
  const router = useRouter()
  const { user, isAuthenticated, isBootstrapping } = useAuth()
  const { activeWorkspace, isLoading: isWorkspaceLoading } = useWorkspace()

  useEffect(() => {
    const redirectHref = getHomeDashboardRedirectHref({
      accountId: user?.accountId,
      isAuthBootstrapping: isBootstrapping,
      isWorkspaceLoading,
      activeWorkspace,
    })

    if (redirectHref) {
      router.replace(redirectHref)
    }
  }, [activeWorkspace, isBootstrapping, isWorkspaceLoading, router, user?.accountId])

  if (isBootstrapping || (isAuthenticated && isWorkspaceLoading)) {
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
