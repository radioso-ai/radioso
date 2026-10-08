import { expect, test } from '@playwright/test'

import {
  baseAccountUsageSummary,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

// The "Plan & usage" label and its meter are generated only for enterprise frontend builds
// (`editionController.canUseEnterpriseUsageLimits`, baked in at build time via
// `NEXT_PUBLIC_RADIOSO_EDITION`), matching how `plan-card.spec.ts` gates its coverage.
// Run locally with `RADIOSO_EDITION=enterprise`.
test.skip(process.env.RADIOSO_EDITION !== 'enterprise', 'Plan & usage is generated only for enterprise frontend builds.');

test('account menu shows Plan & usage with a meter and opens the usage tab', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 412,
        limit: 500,
        credits: 0,
        capacity: 500,
        grace: { limit: 100, borrowed: 0 },
        level: 'nearing_limit' as const,
        byKind: { conversation: 400, copilot: 10, test_run: 2, pulse_report: 0 },
      },
    },
  })

  await page.goto(`/w/${workspaceKey}/account`)
  await page.getByRole('button', { name: /operator@example\.com/ }).click()

  const menuItem = page.getByRole('menuitem', { name: 'Plan & usage' })
  await expect(menuItem).toBeVisible()
  await expect(menuItem).toContainText('412 / 500')

  await menuItem.click()
  await expect(page).toHaveURL(/\/account\?tab=usage$/)
  await expect(page.getByRole('heading', { name: 'Plan & usage' })).toBeVisible()
})

test('account menu hides the meter when the account is not conversation-metered', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: null,
    },
  })

  await page.goto(`/w/${workspaceKey}/account`)
  await page.getByRole('button', { name: /operator@example\.com/ }).click()

  const menuItem = page.getByRole('menuitem', { name: 'Plan & usage' })
  await expect(menuItem).toBeVisible()
  await expect(menuItem).not.toContainText('/')
})
