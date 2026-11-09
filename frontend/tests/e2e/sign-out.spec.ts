import { expect, test, type Page } from '@playwright/test'

import {
  accountId,
  basePlatformSettings,
  installDashboardApiMocks,
  workspaceId,
  workspaceKey,
} from './dashboard-fixtures'

const email = 'operator@example.com'
const password = 'verysecurepassword'

const signedIn = {
  userId: 'user-1',
  displayName: null,
  accountId,
  organizationName: 'Radioso Test',
  workspaceId,
  workspaceName: 'Default',
  workspacePublicRouteKey: workspaceKey,
}

/**
 * A server whose session lives from sign-in until the browser ends it, which is what a reload
 * asks about: the page's own storage can be wiped, the cookie behind `/auth/session` cannot.
 */
const installSessionServer = async (page: Page, options: { logoutStatus?: number } = {}) => {
  const server = { live: false, logoutCalls: 0 }
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  // The shared fixture ends in a catch-all route, and Playwright matches the most recently
  // registered handler first, so these routes are installed after it.
  await page.route('**/backend/api/v1/auth/login', async (route) => {
    server.live = true
    await route.fulfill({ json: signedIn })
  })
  await page.route('**/backend/api/v1/auth/session', async (route) => {
    await route.fulfill(server.live
      ? { json: { ...signedIn, email } }
      : { status: 401, json: { error: { code: 'unauthorized', message: 'Unauthorized' } } })
  })
  await page.route('**/backend/api/v1/auth/logout', async (route) => {
    server.logoutCalls += 1
    const status = options.logoutStatus ?? 204
    if (status === 204) {
      server.live = false
      await route.fulfill({ status })
      return
    }
    await route.fulfill({ status, json: { error: { code: 'internal_error', message: 'Unexpected server error' } } })
  })

  return server
}

const signIn = async (page: Page) => {
  await page.goto('/')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/`), { timeout: 30_000 })
}

const signOutFromAccountMenu = async (page: Page) => {
  await page.getByRole('button', { name: new RegExp(email) }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
}

const signInHeading = (page: Page) => page.getByRole('heading', { name: 'Back in the light' })

test('signing out ends the session, so a reload stays signed out', async ({ page }) => {
  const server = await installSessionServer(page)
  await signIn(page)

  await signOutFromAccountMenu(page)

  await expect(signInHeading(page)).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  expect(server.logoutCalls).toBe(1)

  await page.reload()

  await expect(signInHeading(page)).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
})

test('signing out still lands signed out when the server cannot end the session, and logs why', async ({ page }) => {
  const server = await installSessionServer(page, { logoutStatus: 500 })
  const logged: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') logged.push(message.text())
  })
  await signIn(page)

  await signOutFromAccountMenu(page)

  await expect(signInHeading(page)).toBeVisible()
  await expect(page).toHaveURL(/\/$/)
  expect(server.logoutCalls).toBe(1)
  expect(logged.some((line) => line.includes('Failed to end the server session'))).toBe(true)
})
