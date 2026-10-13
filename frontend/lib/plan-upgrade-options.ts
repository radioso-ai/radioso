type PlanUpgradeOption = { planId: string; label: string; requiresWorkspaceKey: boolean }

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
