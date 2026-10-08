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
  const requestLog: string[] = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    requestLog,
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

  const usageRequests = () => requestLog.filter((entry) => entry.startsWith('GET /ee/usage-limits/me')).length

  await page.goto(`/w/${workspaceKey}/account`)
  await expect(page.getByRole('button', { name: /operator@example\.com/ })).toBeVisible()
  // The dashboard's account usage banner reads the same endpoint on mount; the menu adds
  // exactly one request of its own, and only once it opens.
  await expect.poll(usageRequests).toBeGreaterThanOrEqual(1)
  const beforeOpen = usageRequests()

  await page.getByRole('button', { name: /operator@example\.com/ }).click()

  const menuItem = page.getByRole('menuitem', { name: 'Plan & usage' })
  await expect(menuItem).toBeVisible()
  await expect(menuItem).toContainText('412 / 500')
  expect(usageRequests()).toBe(beforeOpen + 1)

  await menuItem.click()
  await expect(page).toHaveURL(/\/account\?tab=usage$/)
  await expect(page.getByRole('heading', { name: 'Plan & usage' })).toBeVisible()
})

test('retries the meter fetch on the next open after a failure', async ({ page }) => {
  let usageCalls = 0
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
  // Registered after the shared fixture's catch-all, so it is matched first. Every call fails
  // while `failing` is set -- including the dashboard banner's own read of this endpoint on
  // mount -- and falls through to the fixture's success response afterwards.
  let failing = true
  await page.route('**/backend/api/v1/ee/usage-limits/me', async (route) => {
    usageCalls += 1
    if (failing) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
      return
    }
    await route.fallback()
  })

  await page.goto(`/w/${workspaceKey}/account`)
  const trigger = page.getByRole('button', { name: /operator@example\.com/ })
  const menuItem = page.getByRole('menuitem', { name: 'Plan & usage' })
  await expect(trigger).toBeVisible()
  await expect.poll(() => usageCalls).toBeGreaterThanOrEqual(1)
  const beforeOpen = usageCalls

  await trigger.click()
  await expect(menuItem).toBeVisible()
  await expect.poll(() => usageCalls).toBe(beforeOpen + 1)
  await expect(menuItem).not.toContainText('/')
  await page.keyboard.press('Escape')

  // Reopening immediately (well inside the 60s cache window) still retries, because the
  // failed attempt never recorded a last-fetched time.
  failing = false
  await trigger.click()
  await expect(menuItem).toContainText('412 / 500')
  expect(usageCalls).toBe(beforeOpen + 2)
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
