'use client'

import { useEffect, useMemo, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'

import { AuthPage } from '@/components/auth/auth-page'
import { DashboardShell } from '@/components/dashboard/dashboard-shell'
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

  useEffect(() => {
    if (!isBootstrapping && user && !parsedRoute) {
      router.replace('/')
    }
  }, [isBootstrapping, parsedRoute, router, user])

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
            workspaceId: resolved.workspaceId,
            workspacePublicRouteKey: resolved.workspaceKey,
          }
          return current &&
            current.workspaceId === nextState.workspaceId &&
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
    if (!user || !resolvedRouteState) {
      return
    }

    const canonicalHref = buildDashboardHref(user.accountId, resolvedRouteState)
    const currentHref = `${pathname}${searchParamsString ? `?${searchParamsString}` : ''}`
    if (canonicalHref !== currentHref) {
      router.replace(canonicalHref)
    }
  }, [pathname, resolvedRouteState, router, searchParamsString, user])

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
    !resolvedRouteState ||
    resolvedRouteState.workspacePublicRouteKey !== workspaceKey
  ) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <LogoSpinner imageClassName="h-7 w-7" />
      </div>
    )
  }

  return (
    <DashboardShell
      accountId={user.accountId}
      routeState={resolvedRouteState}
    />
  )
}
