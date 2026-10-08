'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { X } from 'lucide-react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  enterpriseBillingApi,
  enterpriseUsageApi,
  type AccountUsageSummary,
  type EnterpriseBillingSummary,
} from '@/lib/api'
import {
  deriveAccountUsageBanner,
  nearingLimitDismissalKey,
  type AccountUsageBannerDescriptor,
} from '@/lib/account-usage-banner'
import { buildDashboardHref, type DashboardRouteState } from '@/lib/dashboard-routes'
import { editionController } from '@/lib/edition-controller'
import { useWorkspace } from '@/lib/workspace-context'

/** Refetch on window focus is throttled so tab-switching during a session does not spam `/me`. */
const FOCUS_REFRESH_THROTTLE_MS = 60_000

/**
 * Enterprise-only usage/billing heads-up, shown app-wide to every account member. Pure precedence
 * and copy live in `lib/account-usage-banner.ts`; this component only fetches, throttles refetch,
 * tracks per-period dismissal, and renders. OSS builds skip the fetch entirely.
 */
export function AccountUsageBanner({
  accountId,
  routeState,
}: {
  accountId: string
  routeState: DashboardRouteState
}) {
  const enabled = editionController.canUseEnterpriseUsageLimits()
  const { activeWorkspaceId, activeWorkspace } = useWorkspace()
  const [usage, setUsage] = useState<AccountUsageSummary | null>(null)
  const [billing, setBilling] = useState<EnterpriseBillingSummary | null>(null)
  const [dismissedPeriod, setDismissedPeriod] = useState<string | null>(null)
  const lastFetchedAtRef = useRef(0)

  const load = useCallback(() => {
    lastFetchedAtRef.current = Date.now()
    void Promise.all([enterpriseUsageApi.getAccountUsage(), enterpriseBillingApi.getSummary()])
      .then(([usageSummary, billingSummary]) => {
        setUsage(usageSummary)
        setBilling(billingSummary)
      })
      // Usage/billing failures never surface as an error banner — the banner simply stays hidden.
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    load()
  }, [enabled, load])

  useEffect(() => {
    if (!enabled) {
      return
    }

    const onFocus = () => {
      if (Date.now() - lastFetchedAtRef.current < FOCUS_REFRESH_THROTTLE_MS) {
        return
      }
      load()
    }

    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [enabled, load])

  const periodStart = usage?.monthlyConversations?.periodStart ?? null

  useEffect(() => {
    if (!periodStart) {
      return
    }
    const isDismissed = window.localStorage.getItem(nearingLimitDismissalKey(periodStart)) === '1'
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reads a client-only localStorage value once the period is known.
    setDismissedPeriod(isDismissed ? periodStart : null)
  }, [periodStart])

  if (!enabled) {
    return null
  }

  const isOnUsageTab = routeState.section === 'account' && routeState.accountTab === 'usage'
  const banner: AccountUsageBannerDescriptor | null = deriveAccountUsageBanner({
    usage,
    billing,
    isOnUsageTab,
    isNearingLimitDismissed: periodStart !== null && dismissedPeriod === periodStart,
  })

  if (!banner) {
    return null
  }

  const usageHref = buildDashboardHref(accountId, {
    section: 'account',
    accountTab: 'usage',
    workspaceId: activeWorkspaceId ?? undefined,
    workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
  })

  const handleDismiss = () => {
    if (!periodStart) {
      return
    }
    window.localStorage.setItem(nearingLimitDismissalKey(periodStart), '1')
    setDismissedPeriod(periodStart)
  }

  return (
    <Alert
      data-testid="account-usage-banner"
      variant={banner.tone}
      role={banner.tone === 'destructive' ? 'alert' : 'status'}
      className="mx-4 mt-3 lg:mx-6"
    >
      <AlertDescription>{banner.message}</AlertDescription>
      <div className="flex items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={usageHref}>{banner.actionLabel}</Link>
        </Button>
        {banner.dismissible ? (
          <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={handleDismiss}>
            <X />
          </Button>
        ) : null}
      </div>
    </Alert>
  )
}
