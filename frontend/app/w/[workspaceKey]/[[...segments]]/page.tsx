'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'

import { AuthPage } from '@/components/auth/auth-page'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
import { WorkspaceEventsProvider } from '@/components/providers/workspace-events-provider'
import { LogoSpinner } from '@/components/ui/spinner'
import {
  accountApi,
  getPendingAccountSwitchId,
  getStoredActiveWorkspaceId,
  getStoredActiveWorkspacePublicRouteKey,
  setPendingAccountSwitchId,
  seedWorkspaceSession,
  workspaceApi,
} from '@/lib/api'
import { useAuth } from '@/lib/auth-context'
import { buildDashboardDocumentTitle } from '@/lib/dashboard-document-title'
import { buildDashboardHref, parseDashboardRoute, withDashboardWorkspace } from '@/lib/dashboard-routes'

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
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { isAuthenticated, isBootstrapping, login, user } = useAuth()
  const workspaceKey = useMemo(() => getParamValue(params.workspaceKey), [params.workspaceKey])
  const [resolvedWorkspace, setResolvedWorkspace] = useState<{
    realtimeEnabled: boolean
    workspaceId: string
    workspacePublicRouteKey: string
  } | null>(() => {
    if (typeof window === 'undefined') {
      return null
    }

    const storedWorkspaceId = getStoredActiveWorkspaceId()
    const storedWorkspacePublicRouteKey = getStoredActiveWorkspacePublicRouteKey()
    if (!storedWorkspaceId || !storedWorkspacePublicRouteKey || storedWorkspacePublicRouteKey !== workspaceKey) {
      return null
    }

    return {
      realtimeEnabled: false,
      workspaceId: storedWorkspaceId,
      workspacePublicRouteKey: storedWorkspacePublicRouteKey,
    }
  })

  const segments = useMemo(() => getParamList(params.segments), [params.segments])
  const searchParamsString = searchParams.toString()
  const parsedRoute = useMemo(
    () => parseDashboardRoute(segments, new URLSearchParams(searchParamsString)),
    [searchParamsString, segments],
  )
  const resolvedRouteState = useMemo(() => {
    if (!parsedRoute || !resolvedWorkspace || resolvedWorkspace.workspacePublicRouteKey !== workspaceKey) {
      return null
    }

    return withDashboardWorkspace(
      parsedRoute,
      resolvedWorkspace.workspaceId,
      resolvedWorkspace.workspacePublicRouteKey,
    )
  }, [parsedRoute, resolvedWorkspace, workspaceKey])
  const currentHref = `${pathname}${searchParamsString ? `?${searchParamsString}` : ''}`
  const canonicalHref = user && resolvedRouteState
    ? buildDashboardHref(user.accountId, resolvedRouteState)
    : null
  const isCanonicalizing = canonicalHref !== null && canonicalHref !== currentHref

  useEffect(() => {
    if (!isBootstrapping && user && !parsedRoute) {
      router.replace('/')
    }
  }, [isBootstrapping, parsedRoute, router, user])

  useEffect(() => {
    if (parsedRoute) {
      document.title = buildDashboardDocumentTitle(parsedRoute.section)
    }
  }, [parsedRoute])

  useEffect(() => {
    if (isBootstrapping || !user || !workspaceKey || !parsedRoute) {
      return
    }

    let cancelled = false

    const resolveRoute = async () => {
      try {
        const resolved = await workspaceApi.resolve(workspaceKey)
        if (cancelled) return
        const pendingAccountSwitchId = getPendingAccountSwitchId()

        if (resolved.accountId !== user.accountId) {
          if (pendingAccountSwitchId && pendingAccountSwitchId !== resolved.accountId) {
            return
          }

          const response = await accountApi.switchAccount(resolved.accountId, resolved.workspaceId)
          if (cancelled) return
          seedWorkspaceSession(response.workspaceId, response.workspacePublicRouteKey)
          await login(user.email, response.userId, response.accountId, response.organizationName)
        } else {
          seedWorkspaceSession(resolved.workspaceId, resolved.workspaceKey)
        }

        if (cancelled) return
        if (pendingAccountSwitchId === resolved.accountId) {
          setPendingAccountSwitchId(null)
        }
        setResolvedWorkspace((current) => {
          const nextState = {
            realtimeEnabled: resolved.realtimeEnabled,
            workspaceId: resolved.workspaceId,
            workspacePublicRouteKey: resolved.workspaceKey,
          }
          return current &&
            current.workspaceId === nextState.workspaceId &&
            current.realtimeEnabled === nextState.realtimeEnabled &&
            current.workspacePublicRouteKey === nextState.workspacePublicRouteKey
            ? current
            : nextState
        })
      } catch {
        if (!cancelled) {
          router.replace('/')
        }
      }
    }

    void resolveRoute()
    return () => { cancelled = true }
  }, [isBootstrapping, login, parsedRoute, router, user, workspaceKey])

  useEffect(() => {
    if (!canonicalHref || !isCanonicalizing) {
      return
    }

    router.replace(canonicalHref)
  }, [canonicalHref, isCanonicalizing, router])

  if (isBootstrapping) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  if (!isAuthenticated || !user) {
    return <AuthPage />
  }

  if (
    !workspaceKey ||
    !parsedRoute ||
    !resolvedWorkspace ||
    !resolvedRouteState ||
    resolvedRouteState.workspacePublicRouteKey !== workspaceKey ||
    isCanonicalizing
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  return (
    <WorkspaceEventsProvider
      workspaceId={resolvedWorkspace.workspaceId}
      realtimeEnabled={resolvedWorkspace.realtimeEnabled}
    >
      <DashboardShell
        accountId={user.accountId}
        routeState={resolvedRouteState}
      />
    </WorkspaceEventsProvider>
  )
}
