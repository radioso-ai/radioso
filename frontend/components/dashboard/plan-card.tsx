'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SegmentedControl, type SegmentedControlOption } from '@/components/ui/segmented-control'
import {
  enterpriseBillingApi,
  plansApi,
  type AccountUsageSummary,
  type BillingInterval,
  type EnterpriseBillingSummary,
  type PlanCatalogResponse,
} from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  formatPlanPriceCents,
  largestPlanUsageKind,
  planUsagePercent,
  planUsageThreshold,
  PLAN_USAGE_KIND_LABELS,
  type PlanUsageKind,
} from '@/lib/plan-card-usage'

type MonthlyConversations = NonNullable<AccountUsageSummary['monthlyConversations']>
type SelfServePlanId = 'satellite' | 'planet'
type PendingAction = 'upgrade' | 'pack' | 'portal' | null

const INTERVAL_OPTIONS: readonly SegmentedControlOption<BillingInterval>[] = [
  { value: 'month', label: 'Monthly' },
  { value: 'year', label: 'Yearly' },
]

const isSelfServePlanId = (planId: string): planId is SelfServePlanId =>
  planId === 'satellite' || planId === 'planet'

const usageKinds = Object.keys(PLAN_USAGE_KIND_LABELS) as PlanUsageKind[]

export function PlanCard({ monthlyConversations }: { monthlyConversations: MonthlyConversations }) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [billing, setBilling] = useState<EnterpriseBillingSummary | null>(null)
  const [plans, setPlans] = useState<PlanCatalogResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkoutInterval, setCheckoutInterval] = useState<BillingInterval>('month')
  const [pendingAction, setPendingAction] = useState<PendingAction>(null)

  useEffect(() => {
    let active = true

    const load = async () => {
      try {
        const [summary, catalog] = await Promise.all([
          enterpriseBillingApi.getSummary(),
          plansApi.getCatalog(),
        ])
        if (!active) return
        setBilling(summary)
        setPlans(catalog)
      } catch (nextError) {
        if (!active) return
        setError(getApiErrorMessage(nextError, 'Failed to load billing.'))
      }
    }

    void load()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const billingParam = searchParams.get('billing')
    if (billingParam !== 'success' && billingParam !== 'canceled') {
      return
    }

    let active = true
    void enterpriseBillingApi.getSummary()
      .then((summary) => {
        if (active) setBilling(summary)
      })
      .catch(() => undefined)

    const nextParams = new URLSearchParams(searchParams.toString())
    nextParams.delete('billing')
    const query = nextParams.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })

    return () => {
      active = false
    }
  }, [searchParams, pathname, router])

  if (!billing || !plans || !billing.configured) {
    return null
  }

  const runCheckout = async (
    body: Parameters<typeof enterpriseBillingApi.createCheckout>[0],
    action: 'upgrade' | 'pack',
  ) => {
    setPendingAction(action)
    setError(null)
    try {
      const { url } = await enterpriseBillingApi.createCheckout(body)
      window.location.assign(url)
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to start checkout.'))
      setPendingAction(null)
    }
  }

  const runPortal = async () => {
    setPendingAction('portal')
    setError(null)
    try {
      const { url } = await enterpriseBillingApi.createPortal({ returnPath: pathname })
      window.location.assign(url)
    } catch (nextError) {
      setError(getApiErrorMessage(nextError, 'Failed to open billing portal.'))
      setPendingAction(null)
    }
  }

  const plan = plans.plans.find((entry) => entry.id === billing.planId)
  const usage = {
    used: monthlyConversations.used,
    limit: monthlyConversations.limit,
    credits: monthlyConversations.credits,
  }
  const percent = planUsagePercent(usage)
  const threshold = planUsageThreshold(usage)
  const largestKind = largestPlanUsageKind(monthlyConversations.byKind)
  const upgradePlanId = billing.upgradePlanId && isSelfServePlanId(billing.upgradePlanId)
    ? billing.upgradePlanId
    : null

  const priceLabel = plan
    ? plan.priceCents === 0
      ? 'Free'
      : `${formatPlanPriceCents(
        billing.interval === 'year' && plan.annualPriceCents !== null ? plan.annualPriceCents : plan.priceCents,
        plans.currency,
      )}/${billing.interval === 'year' ? 'yr' : 'mo'}`
    : billing.planName

  const bannerText = largestKind
    ? `${PLAN_USAGE_KIND_LABELS[largestKind]} are driving most of this month's usage.`
    : "This month's usage is close to the plan limit."

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {upgradePlanId ? (
        <>
          <SegmentedControl
            value={checkoutInterval}
            onValueChange={(nextInterval) => setCheckoutInterval(nextInterval)}
            options={INTERVAL_OPTIONS}
            aria-label="Billing interval"
          />
          <Button
            onClick={() => void runCheckout({ plan: upgradePlanId, interval: checkoutInterval, returnPath: pathname }, 'upgrade')}
            disabled={pendingAction !== null}
          >
            Upgrade
          </Button>
        </>
      ) : null}
      <Button
        variant="outline"
        onClick={() => void runCheckout({ pack: true, returnPath: pathname }, 'pack')}
        disabled={pendingAction !== null}
      >
        Buy {plans.topUp.conversations} more for {formatPlanPriceCents(plans.topUp.priceCents, plans.currency)}
      </Button>
    </div>
  )

  return (
    <Card data-testid="plan-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{billing.planName}</CardTitle>
          <CardDescription>{priceLabel}</CardDescription>
        </div>
        {billing.hasCustomer ? (
          <Button variant="outline" onClick={() => void runPortal()} disabled={pendingAction !== null}>
            Manage billing
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <div className="space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${percent}%` }} />
          </div>
          <div className="text-xs text-muted-foreground">
            {monthlyConversations.used} / {monthlyConversations.limit + monthlyConversations.credits} conversations this month
          </div>
        </div>
        <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          {usageKinds.map((kind) => (
            <div key={kind} className="flex items-center justify-between">
              <span>{PLAN_USAGE_KIND_LABELS[kind]}</span>
              <span className="text-foreground">{monthlyConversations.byKind[kind]}</span>
            </div>
          ))}
        </div>
        {threshold === 'exceeded' ? (
          <div role="status" className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
            <p>{bannerText}</p>
            {actions}
          </div>
        ) : (
          <>
            {threshold === 'warning' ? (
              <p role="status" className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
                {bannerText}
              </p>
            ) : null}
            {actions}
          </>
        )}
      </CardContent>
    </Card>
  )
}
