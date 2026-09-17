import { expect, test } from '@playwright/test'

import {
  baseAccountUsageSummary,
  baseBillingSummary,
  basePlanCatalog,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

// The plan card only renders on enterprise builds (`editionController.canUseEnterpriseUsageLimits`,
// baked in at build time via `NEXT_PUBLIC_RADIOSO_EDITION`). PR CI builds the OSS edition and
// never exercises this file, matching how `operator-console.spec.ts` gates enterprise-only
// coverage. Run locally with `RADIOSO_EDITION=enterprise`.
test.skip(process.env.RADIOSO_EDITION !== 'enterprise', 'The plan card is generated only for enterprise frontend builds.');

test('plan card under 80% usage shows the plan, actions, and no banner', async ({ page }) => {
  const requestLog: string[] = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    requestLog,
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 400,
        limit: 1000,
        credits: 0,
        byKind: { conversation: 380, copilot: 15, test_run: 5, pulse_report: 0 },
      },
    },
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')

  await expect(planCard.getByText('Satellite')).toBeVisible()
  await expect(planCard.getByRole('button', { name: 'Upgrade' })).toBeVisible()
  await expect(planCard.getByRole('button', { name: /Buy 300 more/ })).toBeVisible()
  await expect(planCard.getByRole('button', { name: 'Manage billing' })).toBeVisible()
  await expect(planCard.getByRole('status')).toHaveCount(0)
  await expect
    .poll(() => requestLog.some((entry) => entry.startsWith('GET /ee/billing/me')))
    .toBe(true)
})

test('plan card at 80-99% usage shows a banner naming the largest kind, no buttons in it', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 850,
        limit: 1000,
        credits: 0,
        byKind: { conversation: 300, copilot: 50, test_run: 500, pulse_report: 0 },
      },
    },
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')
  const banner = planCard.getByRole('status')

  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Test runs')
  await expect(banner.getByRole('button', { name: 'Upgrade' })).toHaveCount(0)
  await expect(banner.getByRole('button', { name: /Buy 300 more/ })).toHaveCount(0)
  await expect(planCard.getByRole('button', { name: 'Upgrade' })).toBeVisible()
  await expect(planCard.getByRole('button', { name: /Buy 300 more/ })).toBeVisible()
})

test('plan card at 100% usage shows a banner carrying the Upgrade and Buy buttons', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 1000,
        limit: 1000,
        credits: 0,
        byKind: { conversation: 900, copilot: 50, test_run: 50, pulse_report: 0 },
      },
    },
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')
  const banner = planCard.getByRole('status')

  await expect(banner).toBeVisible()
  await expect(banner).toContainText('Customer conversations')
  await expect(banner.getByRole('button', { name: 'Upgrade' })).toBeVisible()
  await expect(banner.getByRole('button', { name: /Buy 300 more/ })).toBeVisible()
})

test('Manage billing is hidden without a Stripe customer', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    accountUsageSummary: baseAccountUsageSummary(),
    billingSummary: { ...baseBillingSummary(), hasCustomer: false },
    planCatalog: basePlanCatalog(),
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')

  await expect(planCard.getByText('Satellite')).toBeVisible()
  await expect(planCard.getByRole('button', { name: 'Manage billing' })).toHaveCount(0)
})

test('the plan at the self-serve ceiling shows no Upgrade button', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    accountUsageSummary: baseAccountUsageSummary(),
    billingSummary: { ...baseBillingSummary(), planId: 'planet', planName: 'Planet', upgradePlanId: null },
    planCatalog: basePlanCatalog(),
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')

  await expect(planCard.getByText('Planet')).toBeVisible()
  await expect(planCard.getByRole('button', { name: 'Upgrade' })).toHaveCount(0)
  await expect(planCard.getByRole('button', { name: /Buy 300 more/ })).toBeVisible()
})

test('Upgrade posts the plan and interval and navigates to the returned URL', async ({ page }) => {
  const billingRequests: Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    billingRequests,
    accountUsageSummary: baseAccountUsageSummary(),
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
    billingCheckoutUrl: `/w/${workspaceKey}/usage?checkoutTarget=1`,
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')
  await planCard.getByRole('button', { name: 'Upgrade' }).click()

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/usage\\?checkoutTarget=1`))
  await expect
    .poll(() => billingRequests.find((entry) => entry.path === '/ee/billing/checkout'))
    .toEqual({
      method: 'POST',
      path: '/ee/billing/checkout',
      body: { plan: 'planet', interval: 'month', returnPath: `/w/${workspaceKey}/account` },
    })
})

test('Buy posts a top-up pack and navigates to the returned URL', async ({ page }) => {
  const billingRequests: Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    billingRequests,
    accountUsageSummary: baseAccountUsageSummary(),
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
    billingCheckoutUrl: `/w/${workspaceKey}/usage?checkoutTarget=pack`,
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')
  await planCard.getByRole('button', { name: /Buy 300 more/ }).click()

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/usage\\?checkoutTarget=pack`))
  await expect
    .poll(() => billingRequests.find((entry) => entry.path === '/ee/billing/checkout'))
    .toEqual({
      method: 'POST',
      path: '/ee/billing/checkout',
      body: { pack: true, returnPath: `/w/${workspaceKey}/account` },
    })
})

test('Manage billing posts the return path and navigates to the portal URL', async ({ page }) => {
  const billingRequests: Array<{ method: 'GET' | 'POST'; path: string; body?: unknown }> = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    billingRequests,
    accountUsageSummary: baseAccountUsageSummary(),
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
    billingPortalUrl: `/w/${workspaceKey}/usage?portalTarget=1`,
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  const planCard = page.getByTestId('plan-card')
  await planCard.getByRole('button', { name: 'Manage billing' }).click()

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/usage\\?portalTarget=1`))
  await expect
    .poll(() => billingRequests.find((entry) => entry.path === '/ee/billing/portal'))
    .toEqual({
      method: 'POST',
      path: '/ee/billing/portal',
      body: { returnPath: `/w/${workspaceKey}/account` },
    })
})

test('returning with ?billing=success refetches billing state and clears the query param', async ({ page }) => {
  const requestLog: string[] = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    requestLog,
    accountUsageSummary: baseAccountUsageSummary(),
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
  })

  await page.goto(`/w/${workspaceKey}/usage?billing=success`)
  const planCard = page.getByTestId('plan-card')
  await expect(planCard.getByText('Satellite')).toBeVisible()

  // The `/usage` segment redirects client-side to the account page's usage tab
  // (`?tab=usage`), so `billing` is the only query param the plan card should strip.
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/account\\?tab=usage$`))
  await expect
    .poll(() => requestLog.filter((entry) => entry.startsWith('GET /ee/billing/me')).length)
    .toBeGreaterThan(1)
})
