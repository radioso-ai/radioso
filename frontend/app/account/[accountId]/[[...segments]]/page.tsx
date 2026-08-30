'use client'

import { useEffect } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'

import { AuthPage } from '@/components/auth/auth-page'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  accountApi,
  getPendingAccountSwitchId,
  getStoredActiveWorkspaceId,
  getStoredActiveWorkspacePublicRouteKey,
  seedWorkspaceSession,
  workspaceApi,
} from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardHref, parseDashboardRoute } from '@/lib/dashboard-routes'

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

export default function LegacyAccountDashboardPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const auth = useAuth()

  const routeAccountId = getParamValue(params.accountId)
  const segments = getParamList(params.segments)
  const parsedRoute = parseDashboardRoute(segments, searchParams)

  useEffect(() => {
    if (auth.isBootstrapping || !auth.user) {
      return
    }
    const user = auth.user

    const redirectToCanonical = async () => {
      if (!parsedRoute) {
        // No specific place to land (unparseable legacy segments) — same as
        // any other entry with no explicit destination, this defaults to
        // the Inbox rather than a hardcoded section (see app/page.tsx).
        const workspaceId = getStoredActiveWorkspaceId() ?? undefined
        const workspacePublicRouteKey = getStoredActiveWorkspacePublicRouteKey() ?? undefined
        router.replace(buildDashboardHref(user.accountId, {
          section: 'activity',
          workspaceId,
          workspacePublicRouteKey,
        }))
        return
      }

      if (routeAccountId && routeAccountId !== user.accountId) {
        const pendingAccountSwitchId = getPendingAccountSwitchId()
        if (pendingAccountSwitchId && pendingAccountSwitchId !== routeAccountId) {
          return
        }

        try {
          const response = await accountApi.switchAccount(routeAccountId, parsedRoute.workspaceId)
          seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
          await auth.login(user.email, response.userId, response.accountId, response.organizationName)
          router.replace(buildDashboardHref(response.accountId, {
            ...parsedRoute,
            workspaceId: response.workspaceId,
            workspacePublicRouteKey: response.workspacePublicRouteKey,
          }))
          return
        } catch {
          router.replace('/')
          return
        }
      }

      const targetWorkspaceId = parsedRoute.workspaceId ?? getStoredActiveWorkspaceId() ?? undefined
      if (!targetWorkspaceId) {
        router.replace('/')
        return
      }

      try {
        const workspaces = await workspaceApi.list()
        const workspace = workspaces.find((candidate) => candidate.id === targetWorkspaceId)
        if (!workspace) {
          router.replace('/')
          return
        }

        seedWorkspaceSession(workspace.id, workspace.publicRouteKey)
        router.replace(buildDashboardHref(user.accountId, {
          ...parsedRoute,
          workspaceId: workspace.id,
          workspacePublicRouteKey: workspace.publicRouteKey,
        }))
      } catch {
        router.replace('/')
      }
    }

    void redirectToCanonical()
  }, [auth, parsedRoute, routeAccountId, router])

  if (auth.isBootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!auth.isAuthenticated || !auth.user) {
    return <AuthPage />
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <LogoSpinner imageClassName="h-7 w-7" />
    </div>
  )
}
