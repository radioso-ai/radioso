'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'

import { AuthPage } from '@/components/auth/auth-page'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { Spinner } from '@/components/ui/spinner'
import { accountApi, seedWorkspaceSession, workspaceApi } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { parseDashboardRoute, withDashboardWorkspace, type DashboardRouteState } from '@/lib/dashboard-routes'

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

export default function WorkspaceDashboardPage() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const auth = useAuth()
  const [resolvedRouteState, setResolvedRouteState] = useState<DashboardRouteState | null>(null)

  const workspaceKey = getParamValue(params.workspaceKey)
  const segments = getParamList(params.segments)
  const parsedRoute = parseDashboardRoute(segments, searchParams)
  const searchParamsKey = searchParams.toString()

  useEffect(() => {
    setResolvedRouteState(null)
  }, [workspaceKey, searchParamsKey])

  useEffect(() => {
    if (!auth.isBootstrapping && auth.user && !parsedRoute) {
      router.replace('/')
    }
  }, [auth.isBootstrapping, auth.user, parsedRoute, router])

  useEffect(() => {
    if (auth.isBootstrapping || !auth.user || !workspaceKey || !parsedRoute) {
      return
    }

    let cancelled = false

    const resolveRoute = async () => {
      try {
        const resolved = await workspaceApi.resolve(workspaceKey)
        if (cancelled) return

        if (resolved.accountId !== auth.user?.accountId) {
          const response = await accountApi.switchAccount(resolved.accountId, resolved.workspaceId)
          if (cancelled) return
          seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
          await auth.login(auth.user.email, response.userId, response.accountId)
        } else {
          seedWorkspaceSession(resolved.workspaceId, resolved.workspaceKey)
        }

        if (cancelled) return
        setResolvedRouteState(withDashboardWorkspace(parsedRoute, resolved.workspaceId, resolved.workspaceKey))
      } catch {
        if (!cancelled) {
          router.replace('/')
        }
      }
    }

    void resolveRoute()
    return () => { cancelled = true }
  }, [auth, parsedRoute, router, workspaceKey])

  if (auth.isBootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  if (!auth.isAuthenticated || !auth.user) {
    return <AuthPage />
  }

  if (!workspaceKey || !parsedRoute || !resolvedRouteState) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    )
  }

  return (
    <DashboardShell
      accountId={auth.user.accountId}
      routeState={resolvedRouteState}
    />
  )
}
