'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/lib/auth-context'
import { buildAccountRoute } from '@/lib/dashboard-routes'
import { getStoredActiveWorkspaceId } from '@/lib/api'

export function Dashboard() {
  const router = useRouter()
  const { user, isBootstrapping } = useAuth()

  useEffect(() => {
    if (!isBootstrapping && user) {
      const workspaceId =
        typeof window !== 'undefined' ? getStoredActiveWorkspaceId() ?? undefined : undefined
      router.replace(buildAccountRoute(user.accountId, 'chat', undefined, workspaceId))
    }
  }, [isBootstrapping, router, user])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <Spinner className="h-6 w-6" />
    </div>
  )
}
