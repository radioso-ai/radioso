import { expect, test, type Page } from '@playwright/test'

import {
  accountId,
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceId,
  workspaceKey,
} from './dashboard-fixtures'

const signedInEmail = 'operator@example.com'

// The shared fixture ends in a catch-all route, and Playwright matches the most recently
// registered handler first, so these routes are installed after it.
const installProfileMocks = async (page: Page) => {
  let profile: { userId: string; email: string; displayName: string | null } = {
    userId: 'user-1',
    email: signedInEmail,
    displayName: null,
  }
  const updates: unknown[] = []

  await page.route('**/backend/api/v1/auth/profile', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() as { displayName: string | null }
      updates.push(body)
      profile = { ...profile, displayName: body.displayName?.trim() || null }
    }
    await route.fulfill({ json: profile })
  })
  await page.route('**/backend/api/v1/auth/session', async (route) => {
    await route.fulfill({
      json: {
        userId: profile.userId,
        email: profile.email,
        displayName: profile.displayName,
        accountId,
        organizationName: 'Radioso Test',
        workspaceId,
        workspaceName: 'Default',
        workspacePublicRouteKey: workspaceKey,
      },
    })
  })

  return { updates }
}

const member = (overrides: { userId: string; email: string; displayName: string | null; role: 'owner' | 'member' }) => ({
  membershipId: `membership-${overrides.userId}`,
  status: 'active' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
  ...overrides,
})

test('sets a display name from the account menu and shows it on the profile card', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  const { updates } = await installProfileMocks(page)

  await page.goto(`/w/${workspaceKey}/account?tab=usage`)
  await page.getByRole('button', { name: new RegExp(signedInEmail) }).click()
  await expect(page.getByRole('menuitem').first()).toHaveText('Profile')
  await page.getByRole('menuitem', { name: 'Profile' }).click()

  await expect(page).toHaveURL(/\/account\?tab=profile$/)
  await expect(page.getByLabel('Email')).toHaveValue(signedInEmail)
  await page.getByLabel('Display name').fill('Ada Lovelace')
  await page.getByRole('button', { name: 'Save' }).click()

  await expect.poll(() => updates).toEqual([{ displayName: 'Ada Lovelace' }])
  await expect(page.getByRole('button', { name: /Ada Lovelace/ })).toBeVisible()
  await expect(page.getByLabel('Display name')).toHaveValue('Ada Lovelace')
})

test('lists members by display name with their email alongside', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await installProfileMocks(page)
  await page.route('**/backend/api/v1/account/users', async (route) => {
    await route.fulfill({
      json: {
        accountId,
        currentUserId: 'user-1',
        users: [
          member({ userId: 'user-1', email: signedInEmail, displayName: 'Ada Lovelace', role: 'owner' }),
          member({ userId: 'user-2', email: 'unnamed@example.com', displayName: null, role: 'member' }),
        ],
        invitations: [],
        workspaceGrants: [],
      },
    })
  })

  await page.goto(`/w/${workspaceKey}/account`)

  const namedRow = page.getByRole('row').filter({ hasText: 'Ada Lovelace' })
  await expect(namedRow).toContainText(signedInEmail)
  await expect(page.getByRole('row').filter({ hasText: 'unnamed@example.com' })).toBeVisible()
})

test('shows the reason the server gives for rejecting a display name', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await installProfileMocks(page)
  await page.route('**/backend/api/v1/auth/profile', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.fallback()
      return
    }
    await route.fulfill({
      status: 400,
      json: { error: { code: 'bad_request', message: 'Display name must be at most 80 characters' } },
    })
  })

  await page.goto(`/w/${workspaceKey}/account?tab=profile`)
  await page.getByLabel('Display name').fill('a'.repeat(81))
  await page.getByRole('button', { name: 'Save' }).click()

  await expect(page.getByRole('alert').filter({ hasText: 'Display name must be at most 80 characters' })).toBeVisible()
})
