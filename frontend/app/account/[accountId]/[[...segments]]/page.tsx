'use client'

import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'

import { AuthPage } from '@/components/auth/auth-page'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/lib/auth-context'
import {
  buildAccountRoute,
  parseDashboardSegments,
} from '@/lib/dashboard-routes'

const getParamValue = (value: string | string[] | undefined) => {
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}

const getParamList = (value: string | string[] | undefined) => {
  if (!value) {
    return []
  }

  return Array.isArray(value) ? value : [value]
}

export default function AccountDashboardPage() {
  const params = useParams()
  const router = useRouter()
  const { user, isAuthenticated, isBootstrapping } = useAuth()

  const routeAccountId = getParamValue(params.accountId)
  const segments = getParamList(params.segments)
  const parsedRoute = parseDashboardSegments(segments)

  useEffect(() => {
    if (isBootstrapping || !user || !routeAccountId) {
      return
    }

    if (!parsedRoute) {
      router.replace(buildAccountRoute(user.userId, 'chat'))
      return
    }

    if (routeAccountId !== user.userId) {
      router.replace(
        buildAccountRoute(user.userId, parsedRoute.section, parsedRoute.documentId),
      )
    }
  }, [isBootstrapping, parsedRoute, routeAccountId, router, user])

  if (isBootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (!isAuthenticated || !user) {
    return <AuthPage />
  }

  if (!routeAccountId || !parsedRoute || routeAccountId !== user.userId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  return (
    <DashboardShell
      accountId={user.userId}
      currentView={parsedRoute.section}
      selectedDocumentId={parsedRoute.documentId}
    />
  )
}
