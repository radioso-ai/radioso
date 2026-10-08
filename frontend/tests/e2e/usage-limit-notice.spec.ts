import { expect, test } from '@playwright/test'

import {
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

// A usage-limit 429 (EE only: `UsageLimitExceededError`, `ee/packages/backend-module/src/usageLimits/errors.ts`)
// only happens on enterprise builds, matching how `plan-card.spec.ts` gates its coverage.
test.skip(process.env.RADIOSO_EDITION !== 'enterprise', 'Usage limits are only enforced on enterprise builds.');

const importPath = '/backend/api/v1/document/import'

test('a usage-limit 429 on document import shows the plan notice with a working Usage link', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    documentList: { documents: [], total: 0, nextCursor: null, hasMore: false },
  })

  await page.route(
    (url) => url.pathname === importPath,
    async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'usage_limit_exceeded',
            message: 'Usage limit exceeded',
            details: { resource: 'stored_documents', limit: 50, used: 50 },
          },
        }),
      })
    },
  )

  await page.goto(`/w/${workspaceKey}/knowledge`)

  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Import file' }).click()

  await page.getByLabel('File').setInputFiles({
    name: 'guide.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Course guide'),
  })
  await page.getByRole('button', { name: 'Import Document' }).click()

  const notice = page.getByRole('alert').filter({ hasText: "Your plan's document limit is reached." })
  await expect(notice).toBeVisible()

  const usageLink = notice.getByRole('link', { name: 'Review plan and usage' })
  await expect(usageLink).toBeVisible()
  await usageLink.click()

  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/account\\?tab=usage$`))
})
