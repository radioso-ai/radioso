type PlanUpgradeOption = { planId: string; label: string; requiresWorkspaceKey: boolean }
type BillingSubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'none'

export const planUpgradeOptions = (currentPlanId: string, planIds: readonly string[]): PlanUpgradeOption[] =>
  planIds.map((planId) => ({
    planId,
    label: planId === 'planet_managed'
      ? "Planet with Radioso's models"
      : planId === 'planet'
        ? 'Planet — bring your own provider keys'
        : 'Upgrade',
    requiresWorkspaceKey: currentPlanId === 'satellite' && planId === 'planet',
  }))

export const planUpgradeDestination = (
  subscriptionStatus: BillingSubscriptionStatus,
): 'portal' | 'checkout' =>
  subscriptionStatus === 'active' || subscriptionStatus === 'past_due' ? 'portal' : 'checkout'
