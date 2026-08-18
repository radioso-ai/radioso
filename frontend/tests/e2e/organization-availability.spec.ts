import { expect, test, type Page } from '@playwright/test'

import {
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

const installAuthMocks = async (
  page: Page,
  available: boolean,
  beforeRegistrationResponse?: () => Promise<void>,
) => {
  await page.route('**/backend/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/backend\/api\/v1/, '')
    if (path === '/auth/registration') {
      await beforeRegistrationResponse?.()
    }
    const body = path === '/auth/registration'
      ? { available }
      : path === '/ee/auth/google/status'
        ? { enabled: false }
        : { error: { code: 'not_found', message: 'Not found' } }

    await route.fulfill({
      status: path === '/auth/registration' || path === '/ee/auth/google/status' ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  })
}

test('offers first-user registration when the server reports it available', async ({ page }) => {
  await installAuthMocks(page, true)

  await page.goto('/')

  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await expect(page.getByText('Agents that answer, act, and hand off — inside the rules you set.', { exact: true })).toBeVisible()
})

test('enters the workspace directly after a development auto-verified registration', async ({ page }) => {
  await page.route('**/backend/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/backend\/api\/v1/, '')
    const method = route.request().method()

    if (path === '/auth/registration') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ available: true }) })
      return
    }
    if (path === '/auth/register' && method === 'POST') {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: '11111111-1111-4111-8111-111111111111',
          accountId: '22222222-2222-4222-8222-222222222222',
          organizationName: 'Local Dev Organization',
          workspaceId: '33333333-3333-4333-8333-333333333333',
          workspaceName: 'Default',
          workspacePublicRouteKey: '1234567890',
          requiresEmailVerification: false,
        }),
      })
      return
    }
    if (path === '/workspace' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          workspaces: [{
            id: '33333333-3333-4333-8333-333333333333',
            accountId: '22222222-2222-4222-8222-222222222222',
            name: 'Default',
            publicRouteKey: '1234567890',
            createdAt: '2026-08-17T00:00:00.000Z',
            updatedAt: '2026-08-17T00:00:00.000Z',
          }],
        }),
      })
      return
    }
    if (path === '/agents' && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ agents: [] }) })
      return
    }
    if (path === '/ee/auth/google/status') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: false }) })
      return
    }

    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Register' }).click()
  await page.getByLabel('Email').fill('local-dev@example.com')
  await page.getByLabel('Password', { exact: true }).fill('verysecurepassword')
  await page.getByLabel('Confirm Password').fill('verysecurepassword')
  await page.getByRole('button', { name: 'Create Account' }).click()

  await expect(page.getByRole('heading', { name: 'Verify your email' })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('radioso.authUser'))).toContain('local-dev@example.com')
})

test('shows invitation guidance without flashing registration when registration is closed', async ({ page }) => {
  let markRegistrationRequested: () => void = () => undefined
  const registrationRequested = new Promise<void>((resolve) => {
    markRegistrationRequested = resolve
  })
  let releaseRegistrationResponse: () => void = () => undefined
  const releaseResponse = new Promise<void>((resolve) => {
    releaseRegistrationResponse = resolve
  })
  await installAuthMocks(page, false, async () => {
    markRegistrationRequested()
    await releaseResponse
  })

  await page.goto('/')
  await registrationRequested

  await expect(page.getByRole('button', { name: 'Register' })).toHaveCount(0)
  releaseRegistrationResponse()

  await expect(page.getByText('Registration is invitation-only. Ask an organization administrator for an invitation.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Register' })).toHaveCount(0)
})

test('recovers registration availability after a transient startup failure without flashing signup', async ({ page }) => {
  let attempts = 0
  let backendReady = false
  await page.route('**/backend/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/backend\/api\/v1/, '')
    if (path === '/auth/registration') {
      attempts += 1
      if (!backendReady) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'service_unavailable', message: 'Starting' } }),
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: true }),
      })
      return
    }

    await route.fulfill({
      status: path === '/ee/auth/google/status' ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify(path === '/ee/auth/google/status'
        ? { enabled: false }
        : { error: { code: 'not_found', message: 'Not found' } }),
    })
  })

  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Register' })).toHaveCount(0)
  await expect(page.getByText('Unable to check registration availability.')).toBeVisible()
  backendReady = true
  await page.getByRole('button', { name: 'Retry registration check' }).click()

  await expect(page.getByRole('button', { name: 'Register' })).toBeVisible()
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('keeps workspace creation while hiding additional organization creation in OSS', async ({ page }) => {
  let createdWorkspaceName: string | null = null
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page)
  await page.route('**/backend/api/v1/workspace', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }

    createdWorkspaceName = (route.request().postDataJSON() as { name: string }).name
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'workspace-2',
        accountId: 'account-1',
        name: createdWorkspaceName,
        publicRouteKey: 'workspace-key-2',
        createdAt: '2026-07-20T12:00:00.000Z',
        updatedAt: '2026-07-20T12:00:00.000Z',
      }),
    })
  })

  await page.goto(`/w/${workspaceKey}/knowledge`)
  await page.getByRole('button', { name: /radioso logo Radioso Test/i }).click()

  await expect(page.getByRole('menuitem', { name: 'New workspace' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'New organization' })).toHaveCount(0)

  await page.getByRole('menuitem', { name: 'New workspace' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Create workspace' })).toBeVisible()
  await dialog.getByPlaceholder('Workspace name').fill('Research')
  await dialog.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(() => createdWorkspaceName).toBe('Research')
})
