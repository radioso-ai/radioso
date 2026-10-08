import { expect, test } from '@playwright/test'

import {
  baseAccountUsageSummary,
  baseBillingSummary,
  basePlanCatalog,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

// The banner only renders on enterprise builds (`editionController.canUseEnterpriseUsageLimits`,
// baked in at build time via `NEXT_PUBLIC_RADIOSO_EDITION`), same gating as `plan-card.spec.ts`.
// Run locally with `RADIOSO_EDITION=enterprise`.
test.skip(process.env.RADIOSO_EDITION !== 'enterprise', 'The account usage banner is generated only for enterprise frontend builds.');

test('limit_reached shows on a non-usage page and Review usage links to the usage tab', async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 1000,
        limit: 1000,
        credits: 0,
        capacity: 1000,
        grace: { limit: 100, borrowed: 20 },
        level: 'limit_reached',
        byKind: { conversation: 950, copilot: 30, test_run: 20, pulse_report: 0 },
      },
    },
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
  });

  await page.goto(`/w/${workspaceKey}/knowledge`);
  const banner = page.getByTestId('account-usage-banner');

  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner).toContainText('up to 80 extra conversations');

  await banner.getByRole('link', { name: 'Review usage' }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/account\\?tab=usage$`));
});

test('the banner hides on the account usage tab itself', async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 1000,
        limit: 1000,
        credits: 0,
        capacity: 1000,
        grace: { limit: 100, borrowed: 20 },
        level: 'limit_reached',
        byKind: { conversation: 950, copilot: 30, test_run: 20, pulse_report: 0 },
      },
    },
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
  });

  await page.goto(`/w/${workspaceKey}/account?tab=usage`);
  await expect(page.getByTestId('plan-card')).toBeVisible();
  await expect(page.getByTestId('account-usage-banner')).toHaveCount(0);
});

test('nearing_limit can be dismissed and the dismissal survives a reload', async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 850,
        limit: 1000,
        credits: 0,
        capacity: 1000,
        grace: { limit: 100, borrowed: 0 },
        level: 'nearing_limit',
        byKind: { conversation: 800, copilot: 30, test_run: 20, pulse_report: 0 },
      },
    },
    billingSummary: baseBillingSummary(),
    planCatalog: basePlanCatalog(),
  });

  await page.goto(`/w/${workspaceKey}/knowledge`);
  const banner = page.getByTestId('account-usage-banner');

  await expect(banner).toBeVisible();
  await expect(banner).toContainText("You've used 85%");
  await banner.getByRole('button', { name: 'Dismiss' }).click();
  await expect(banner).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('account-usage-banner')).toHaveCount(0);
});

test('past_due takes precedence over a grace_exhausted usage level', async ({ page }) => {
  await seedDashboardStorage(page);
  await installDashboardApiMocks(page, {
    accountUsageSummary: {
      ...baseAccountUsageSummary(),
      monthlyConversations: {
        periodStart: '2026-04-01',
        resetAt: '2026-05-01T00:00:00.000Z',
        used: 1100,
        limit: 1000,
        credits: 0,
        capacity: 1100,
        grace: { limit: 100, borrowed: 100 },
        level: 'grace_exhausted',
        byKind: { conversation: 1050, copilot: 30, test_run: 20, pulse_report: 0 },
      },
    },
    billingSummary: { ...baseBillingSummary(), status: 'past_due' },
    planCatalog: basePlanCatalog(),
  });

  await page.goto(`/w/${workspaceKey}/knowledge`);
  const banner = page.getByTestId('account-usage-banner');

  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'alert');
  await expect(banner).toContainText("Your last payment didn't go through");
  await expect(banner).not.toContainText('stopped answering visitors');
  await expect(banner.getByRole('link', { name: 'Manage billing' })).toBeVisible();
});
