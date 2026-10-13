import { expect, test, type Page } from '@playwright/test'

const session = {
  userId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  organizationName: 'Radioso Test',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  workspaceName: 'Default',
  workspacePublicRouteKey: 'workspace-key',
  requiresEmailVerification: false,
  email: 'operator@example.com',
}

const workspace = {
  id: session.workspaceId,
  accountId: session.accountId,
  name: session.workspaceName,
  publicRouteKey: session.workspacePublicRouteKey,
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:00:00.000Z',
}

const workspaceSummary = {
  documentCount: 0,
  readyDocumentCount: 0,
  pendingDocumentCount: 0,
  sampleDocumentCount: 0,
  sampleDocumentSlugs: [],
  conversationCount: 0,
  hasDocuments: false,
  hasPendingDocuments: false,
  hasReadyDocuments: false,
  hasCompletedChat: false,
  sampleDocumentsImported: false,
  websiteCrawlerEnabled: true,
}

const installAuthFunnelMocks = async (
  page: Page,
  state: {
    verified: boolean
    registrationStatus?: number
    googleEnabled?: boolean
    pendingExchangeCount?: number
  },
  options: { allowVerifiedSession?: boolean } = {},
) => {
  await page.route('**/backend/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/backend\/api\/v1/, '')
    const method = request.method()

    if (path === '/auth/session' && method === 'GET') {
      if (state.verified && options.allowVerifiedSession !== false) {
        await route.fulfill({ json: session })
      } else {
        await route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'No session' } } })
      }
      return
    }
    if (path === '/auth/registration' && method === 'GET') {
      const status = state.registrationStatus ?? 200
      await route.fulfill({
        status,
        json: status === 200
          ? { available: true }
          : { error: { code: 'service_unavailable', message: 'Starting' } },
      })
      return
    }
    if (path === '/ee/auth/google/status' && method === 'GET') {
      await route.fulfill({ json: { enabled: state.googleEnabled ?? false } })
      return
    }
    if (path === '/auth/register' && method === 'POST') {
      await route.fulfill({
        status: 201,
        json: {
          ...session,
          displayName: 'Operator',
          requiresEmailVerification: true,
          developmentVerificationUrl: '/verify-email?token=dev-verification-token',
        },
      })
      return
    }
    if (path === '/auth/email-verification/verify' && method === 'POST') {
      state.verified = true
      await route.fulfill({ json: { verified: true } })
      return
    }
    if (path === '/auth/email-verification/pending-session' && method === 'POST') {
      state.pendingExchangeCount = (state.pendingExchangeCount ?? 0) + 1
      await route.fulfill({ json: { ready: state.verified } })
      return
    }
    if (path === '/workspace' && method === 'GET') {
      await route.fulfill({ json: { workspaces: [workspace] } })
      return
    }
    if (path === '/workspace/summary' && method === 'GET') {
      await route.fulfill({ json: workspaceSummary })
      return
    }
    if (path === '/agents' && method === 'GET') {
      await route.fulfill({ json: { agents: [] } })
      return
    }
    if (path === `/workspace/resolve/${session.workspacePublicRouteKey}` && method === 'GET') {
      await route.fulfill({
        json: {
          workspaceKey: session.workspacePublicRouteKey,
          workspaceId: session.workspaceId,
          workspaceName: session.workspaceName,
          accountId: session.accountId,
          organizationName: session.organizationName,
          realtimeEnabled: false,
        },
      })
      return
    }
    if (path === '/account/accounts' && method === 'GET') {
      await route.fulfill({
        json: {
          accounts: [{
            accountId: session.accountId,
            organizationName: session.organizationName,
            role: 'admin',
            status: 'active',
          }],
        },
      })
      return
    }
    if (path === '/observability/product-analytics' && method === 'POST') {
      await route.fulfill({ status: 202, json: { accepted: true } })
      return
    }

    await route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: `Unhandled ${method} ${path}` } },
    })
  })
}

test('keeps signup linkable while the availability probe is unavailable', async ({ page }) => {
  await installAuthFunnelMocks(page, { verified: false, registrationStatus: 503 })

  await page.goto('/signup')

  await expect(page.getByRole('heading', { name: 'Step into the light' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
})

test('registers, verifies in another tab, and signs in the waiting tab', async ({ page, context }) => {
  const state = { verified: false, pendingExchangeCount: 0 }
  await installAuthFunnelMocks(page, state)
  await page.goto('/signup')
  await page.getByLabel('Your name (optional)').fill('Operator')
  await page.getByLabel('Email').fill('operator@example.com')
  await page.getByLabel('Password', { exact: true }).fill('verysecurepassword')
  await page.getByLabel('Confirm Password').fill('verysecurepassword')
  await page.getByRole('button', { name: 'Create account' }).click()

  await expect(page.getByRole('heading', { name: 'Check your inbox' })).toBeVisible()
  const developmentLink = page.getByRole('link', { name: 'Open development verification link' })
  await expect(developmentLink).toHaveAttribute('href', '/verify-email?token=dev-verification-token')
  await expect.poll(() => state.pendingExchangeCount).toBeGreaterThan(0)

  const verificationPage = await context.newPage()
  // Keep the mocked verification tab from seeding shared local storage. The
  // registering tab must observe verification through its pending exchange.
  await installAuthFunnelMocks(verificationPage, state, { allowVerifiedSession: false })
  await verificationPage.goto('/verify-email?token=dev-verification-token')

  await expect.poll(() => state.verified).toBe(true)
  await page.bringToFront()
  await expect(page).toHaveURL(/\/w\/workspace-key\/agents(?:\/|$)/, { timeout: 30_000 })
})

test('a verification link lands signed in without asking for credentials', async ({ page }) => {
  const state = { verified: false }
  await installAuthFunnelMocks(page, state)

  await page.goto('/verify-email?token=verification-token')

  await expect(page).toHaveURL(/\/w\/workspace-key\/agents(?:\/|$)/, { timeout: 10_000 })
  await expect.poll(() => state.verified).toBe(true)
})

test('redirects signed-in visitors away from auth routes', async ({ page }) => {
  await installAuthFunnelMocks(page, { verified: true })

  await page.goto('/login')

  await expect(page).toHaveURL(/\/w\/workspace-key\/agents(?:\/|$)/, { timeout: 10_000 })
})

test('shows Google registration only when Enterprise Google login is enabled', async ({ page }) => {
  await installAuthFunnelMocks(page, { verified: false, googleEnabled: true })
  await page.goto('/signup')
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()

  const disabledPage = await page.context().newPage()
  await installAuthFunnelMocks(disabledPage, { verified: false, googleEnabled: false })
  await disabledPage.goto('/signup')
  await expect(disabledPage.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
})
