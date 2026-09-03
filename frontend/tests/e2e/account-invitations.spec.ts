import { expect, test, type Page } from '@playwright/test'

import {
  accountId,
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

const owner = {
  membershipId: 'membership-1',
  userId: 'user-1',
  email: 'operator@example.com',
  role: 'owner' as const,
  status: 'active' as const,
  createdAt: '2026-08-01T00:00:00.000Z',
}

const installAccountUserMocks = async (page: Page, options: { emailDelivered: boolean }) => {
  await page.route('**/backend/api/v1/account/users', async (route) => {
    await route.fulfill({
      json: { accountId, currentUserId: owner.userId, users: [owner], invitations: [], workspaceGrants: [] },
    })
  })
  await page.route('**/backend/api/v1/account/invitations', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { email: string }
    await route.fulfill({
      status: 201,
      json: {
        id: 'invitation-1',
        email: body.email,
        status: 'pending',
        role: 'member',
        expiresAt: '2026-09-09T00:00:00.000Z',
        acceptedAt: null,
        createdAt: '2026-09-02T00:00:00.000Z',
        acceptanceUrl: '/invite/token-123',
        emailDelivered: options.emailDelivered,
      },
    })
  })
}

const openInviteDialog = async (page: Page, options: { emailDelivered: boolean }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  // The shared fixture ends in a catch-all route, and Playwright matches the most recently
  // registered handler first, so the account routes have to be installed after it.
  await installAccountUserMocks(page, options)
  await page.goto(`/w/${workspaceKey}/account`)
  await page.getByRole('button', { name: 'Invite member' }).click()
  await page.getByLabel('Email address').fill('teammate@example.com')
  await page.getByRole('button', { name: 'Send invite' }).click()
}

test('reports the mailbox the invitation reached', async ({ page }) => {
  await openInviteDialog(page, { emailDelivered: true })

  await expect(page.getByTestId('invite-delivery-status')).toHaveText('Emailed to teammate@example.com')
  await expect(page.getByText('Backup invite link')).toBeVisible()

  // Radix hides the page behind an open dialog from the accessibility tree, so the pending
  // row is only reachable once the dialog is dismissed.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('cell', { name: 'teammate@example.com' })).toBeVisible()
})

test('tells the operator to share the link when the invitation email fails', async ({ page }) => {
  await openInviteDialog(page, { emailDelivered: false })

  await expect(page.getByTestId('invite-delivery-status')).toHaveText('Email failed to send. Share the link instead.')
  await expect(page.getByText('Share invite link')).toBeVisible()

  // The invitation itself is still valid, so the pending row must appear either way.
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('cell', { name: 'teammate@example.com' })).toBeVisible()
})
