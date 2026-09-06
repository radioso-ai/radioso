import { expect, test, type Locator, type Page } from '@playwright/test'

type InvitationFixture = {
  accountId: string
  email: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  expiresAt: string
  requiresExistingPassword: boolean
  federatedProviders: string[]
}

type LoginResponseFixture = {
  userId: string
  accountId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
  workspacePublicRouteKey: string
}

const nowIso = '2026-04-26T12:00:00.000Z'

const defaultLoginResponse: LoginResponseFixture = {
  userId: '11111111-1111-4111-8111-111111111111',
  accountId: '22222222-2222-4222-8222-222222222222',
  organizationName: 'Acme Support',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  workspaceName: 'Default',
  workspacePublicRouteKey: 'acme-support-key',
}

type SessionWorkspaceFixture = {
  id: string
  accountId: string
  name: string
  publicRouteKey: string
}

// Mirrors the `SessionResponse` contract returned by `GET /auth/session` (see
// lib/api-auth.ts): the payload `AuthProvider` recovers an identity from when a provider OAuth
// redirect set the session cookie without ever calling `login()`.
type SessionFixture = {
  userId: string
  accountId: string
  organizationName: string
  workspaceId: string
  workspaceName: string
  workspacePublicRouteKey: string
  requiresEmailVerification: boolean
  email: string
}

// Mocks the invitation contract: GET details, GET Google status, and the two accept
// endpoints. A catch-all 404 keeps unrelated fetches from hanging the test.
//
// It also answers `/workspace` and `/account/accounts`, which the invitation screen itself
// never calls. The app's global WorkspaceProvider (mounted at the root layout, so it is active
// on every route including this one) validates any signed-in session against those two
// endpoints as soon as `user` is non-null, and logs the session back out if either call fails.
// Any scenario that starts, or ends up, signed in has to answer them or the assertions race a
// session the app is in the middle of tearing down. `sessionWorkspaces` lets a test that
// expects to land in the dashboard put the joined workspace in that list, so the destination
// route's own guard recognizes it instead of bouncing to `/`.
const installInvitationApiMocks = async (
  page: Page,
  options: {
    token: string
    invitation: InvitationFixture
    googleEnabled?: boolean
    loginResponse?: LoginResponseFixture
    sessionWorkspaces?: SessionWorkspaceFixture[]
    // `undefined` (the default) leaves `/auth/session` unhandled, so it falls through to the
    // catch-all 404 below — matching a first-time visitor with no session cookie, same as before
    // this endpoint existed. Pass a fixture to simulate a returning provider-OAuth session, or
    // `null` to simulate an explicit 401 (a cookie that expired or was never set).
    session?: SessionFixture | null
    onAccept?: (body: unknown) => void
    onAcceptAsCurrentUser?: () => void
  },
) => {
  const {
    token,
    invitation,
    googleEnabled = false,
    loginResponse = defaultLoginResponse,
    sessionWorkspaces = [],
    session,
  } = options

  await page.route('**/backend/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace(/^\/backend\/api\/v1/, '')
    const method = request.method()

    if (path === `/auth/invitations/${token}` && method === 'GET') {
      await route.fulfill({ json: invitation })
      return
    }
    if (path === '/ee/auth/google/status' && method === 'GET') {
      await route.fulfill({ json: { enabled: googleEnabled } })
      return
    }
    if (path === '/auth/session' && method === 'GET' && session !== undefined) {
      if (session === null) {
        await route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'No session' } } })
      } else {
        await route.fulfill({ json: session })
      }
      return
    }
    if (path === `/auth/invitations/${token}/accept` && method === 'POST') {
      options.onAccept?.(request.postDataJSON())
      await route.fulfill({ json: loginResponse })
      return
    }
    if (path === `/auth/invitations/${token}/accept-as-current-user` && method === 'POST') {
      options.onAcceptAsCurrentUser?.()
      await route.fulfill({ json: loginResponse })
      return
    }
    if (path === '/workspace' && method === 'GET') {
      await route.fulfill({
        json: {
          workspaces: sessionWorkspaces.map((workspace) => ({
            ...workspace,
            createdAt: nowIso,
            updatedAt: nowIso,
          })),
        },
      })
      return
    }
    if (path === '/account/accounts' && method === 'GET') {
      await route.fulfill({ json: { accounts: [] } })
      return
    }

    await route.fulfill({
      status: 404,
      json: { error: { code: 'not_found', message: 'Not found' } },
    })
  })
}

// The auth context bootstraps from this localStorage key (see lib/auth-context.tsx). Unlike
// dashboard-fixtures.ts's seedDashboardStorage, the email here has to vary per test to cover
// the matched- and mismatched-session cases, so it is not reused.
const seedSignedInUser = async (
  page: Page,
  user: { userId: string; accountId: string; email: string },
) => {
  await page.addInitScript((authUser) => {
    window.localStorage.setItem('radioso.authUser', JSON.stringify(authUser))
    window.localStorage.setItem('radioso.lastAccountId', authUser.accountId)
  }, user)
}

// Reads a visible element's top offset so two locators' vertical order can be
// compared without asserting on markup structure or DOM index.
const topOffsetOf = async (locator: Locator): Promise<number> => {
  const box = await locator.boundingBox()
  if (!box) {
    throw new Error('Expected element to have a bounding box (is it visible?)')
  }
  return box.y
}

test('new-user invitation collects a new password with confirmation and no reset link', async ({ page }) => {
  const token = 'invite-new-user'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-new',
      email: 'newhire@example.com',
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByText('Choose a password to finish setting up your login.')).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveValue('newhire@example.com')
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Confirm password')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
})

test('existing-user invitation skips confirmation, links to reset password, and accepts with the existing credential', async ({ page }) => {
  const token = 'invite-existing-user'
  const invitedEmail = 'returning@example.com'
  let acceptedBody: unknown = null
  const loginResponse = { ...defaultLoginResponse, workspacePublicRouteKey: 'returning-key' }

  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-existing',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: true,
      federatedProviders: [],
    },
    loginResponse,
    sessionWorkspaces: [{
      id: loginResponse.workspaceId,
      accountId: loginResponse.accountId,
      name: loginResponse.workspaceName,
      publicRouteKey: loginResponse.workspacePublicRouteKey,
    }],
    onAccept: (body) => {
      acceptedBody = body
    },
  })

  await page.goto(`/invite/${token}`)

  await expect(
    page.getByText('You already have a Radioso login. Enter your existing password to join.'),
  ).toBeVisible()
  await expect(page.getByLabel('Confirm password')).toHaveCount(0)

  const forgotLink = page.getByRole('link', { name: 'Forgot password?' })
  await expect(forgotLink).toBeVisible()
  await expect(forgotLink).toHaveAttribute('href', `/reset-password?email=${encodeURIComponent(invitedEmail)}`)

  await page.getByLabel('Password', { exact: true }).fill('supersecret123')
  await page.getByRole('button', { name: 'Join account' }).click()

  await expect.poll(() => acceptedBody).toEqual({ email: invitedEmail, password: 'supersecret123' })
  await page.waitForURL((url) => url.pathname.startsWith('/w/'))
})

test('an invitation for a login not linked to Google shows no Google button even when this deployment offers Google', async ({ page }) => {
  // Offering Google here would send a visitor with no Radioso account through provider sign-up,
  // which provisions a stray organization instead of joining this one — so the button only ever
  // appears for a login already linked to Google (see the fixture below for that case).
  const token = 'invite-google'
  const invitedEmail = 'google-join@example.com'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-google',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
    googleEnabled: true,
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByText('Choose a password to finish setting up your login.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
})

test('a session signed in as the invited address joins without a password and enters the dashboard', async ({ page }) => {
  const token = 'invite-signed-in-match'
  const invitedEmail = 'teammate@example.com'
  let acceptAsCurrentUserCalled = false
  const loginResponse = { ...defaultLoginResponse, workspacePublicRouteKey: 'teammate-key' }

  await seedSignedInUser(page, { userId: 'user-1', accountId: 'account-1', email: invitedEmail })
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-1',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
    loginResponse,
    sessionWorkspaces: [{
      id: loginResponse.workspaceId,
      accountId: loginResponse.accountId,
      name: loginResponse.workspaceName,
      publicRouteKey: loginResponse.workspacePublicRouteKey,
    }],
    onAcceptAsCurrentUser: () => {
      acceptAsCurrentUserCalled = true
    },
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByText(`Signed in as ${invitedEmail}`)).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Join account' }).click()

  await expect.poll(() => acceptAsCurrentUserCalled).toBe(true)
  await page.waitForURL((url) => url.pathname.startsWith('/w/'))
})

test('a session signed in as a different address shows the mismatch without a join option', async ({ page }) => {
  const token = 'invite-signed-in-mismatch'
  const invitedEmail = 'invited-person@example.com'
  const signedInEmail = 'someone-else@example.com'

  await seedSignedInUser(page, { userId: 'user-2', accountId: 'account-2', email: signedInEmail })
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-2',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByText(signedInEmail, { exact: true })).toBeVisible()
  await expect(page.getByText(invitedEmail, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Use a different account' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Join account' })).toHaveCount(0)
})

test('a non-pending invitation is blocked without a form', async ({ page }) => {
  const token = 'invite-revoked'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-revoked',
      email: 'gone@example.com',
      status: 'revoked',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByText('This invitation is revoked.')).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Join account' })).toHaveCount(0)
})

test('a failed Google return shows an error banner above the invitation body', async ({ page }) => {
  const token = 'invite-google-failure'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-google-failure',
      email: 'retry@example.com',
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
  })

  await page.goto(`/invite/${token}?error=google_login_failed`)

  await expect(page.getByText('Google sign-in did not complete. Try again.')).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveValue('retry@example.com')
})

test('an existing login linked to Google leads with Google when this deployment offers it', async ({ page }) => {
  const token = 'invite-google-linked-enabled'
  const invitedEmail = 'linked-enabled@example.com'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-google-linked-enabled',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: true,
      federatedProviders: ['google'],
    },
    googleEnabled: true,
  })

  let googleStartUrl: string | null = null
  // The button does a full-page navigation (window.location.assign), so the target is read by
  // intercepting and aborting that request rather than by asserting page.url() after a real
  // (and here, unmockable) OAuth redirect.
  await page.route('**/backend/api/v1/ee/auth/google/start**', async (route) => {
    googleStartUrl = route.request().url()
    await route.abort()
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByText('This account signs in with Google.')).toBeVisible()
  const googleButton = page.getByRole('button', { name: 'Continue with Google' })
  await expect(googleButton).toHaveCount(1)
  await expect(googleButton).toBeVisible()
  await expect(page.getByText('Or enter your existing password.')).toBeVisible()

  const passwordInput = page.getByLabel('Password', { exact: true })
  await expect(passwordInput).toBeVisible()
  expect(await topOffsetOf(googleButton)).toBeLessThan(await topOffsetOf(passwordInput))

  await googleButton.click()

  await expect.poll(() => googleStartUrl).not.toBeNull()
  if (!googleStartUrl) {
    throw new Error('Google start URL was not captured')
  }
  const parsed = new URL(googleStartUrl)
  expect(parsed.pathname).toContain('/ee/auth/google/start')
  expect(parsed.searchParams.get('returnTo')).toBe(`/invite/${token}`)
  expect(parsed.searchParams.get('loginHint')).toBe(invitedEmail)
})

test('an existing login linked to Google without Google on this deployment points at resetting the password', async ({ page }) => {
  const token = 'invite-google-linked-disabled'
  const invitedEmail = 'linked-disabled@example.com'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-google-linked-disabled',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: true,
      federatedProviders: ['google'],
    },
    googleEnabled: false,
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
  await expect(
    page.getByText('This account signs in with Google, which this server does not offer. Reset your password to join.'),
  ).toBeVisible()

  const forgotLink = page.getByRole('link', { name: 'Forgot password?' })
  await expect(forgotLink).toBeVisible()
  await expect(forgotLink).toHaveAttribute('href', `/reset-password?email=${encodeURIComponent(invitedEmail)}`)
})

test('an existing login not linked to Google shows only the password form, even when this deployment offers Google', async ({ page }) => {
  const token = 'invite-google-unlinked-enabled'
  const invitedEmail = 'unlinked-enabled@example.com'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-google-unlinked-enabled',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: true,
      federatedProviders: [],
    },
    googleEnabled: true,
  })

  await page.goto(`/invite/${token}`)

  await expect(
    page.getByText('You already have a Radioso login. Enter your existing password to join.'),
  ).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
})

test('returning from a Google redirect recovers the session cookie and joins without a password', async ({ page }) => {
  // This is the regression the whole fix was for: provider OAuth sets the session cookie via a
  // browser redirect and never calls `login()`, so with no localStorage entry and no session
  // recovery the visitor came back looking signed out and had to re-authenticate through a path
  // that could never finish the join. No `seedSignedInUser` call here — the only thing making
  // this visitor look authenticated is the mocked `GET /auth/session` response.
  const token = 'invite-google-return'
  const invitedEmail = 'returning-google@example.com'
  let acceptAsCurrentUserCalled = false
  const loginResponse = { ...defaultLoginResponse, workspacePublicRouteKey: 'google-return-key' }
  const session: SessionFixture = {
    userId: 'google-return-user',
    accountId: loginResponse.accountId,
    organizationName: loginResponse.organizationName,
    workspaceId: loginResponse.workspaceId,
    workspaceName: loginResponse.workspaceName,
    workspacePublicRouteKey: loginResponse.workspacePublicRouteKey,
    requiresEmailVerification: false,
    email: invitedEmail,
  }

  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-google-return',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
    loginResponse,
    session,
    sessionWorkspaces: [{
      id: loginResponse.workspaceId,
      accountId: loginResponse.accountId,
      name: loginResponse.workspaceName,
      publicRouteKey: loginResponse.workspacePublicRouteKey,
    }],
    onAcceptAsCurrentUser: () => {
      acceptAsCurrentUserCalled = true
    },
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByText(`Signed in as ${invitedEmail}`)).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveCount(0)
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'Join account' }).click()

  await expect.poll(() => acceptAsCurrentUserCalled).toBe(true)
  await page.waitForURL((url) => url.pathname.startsWith('/w/'))
})

test('with no live session, the credential form renders instead of a signed-in join panel', async ({ page }) => {
  const token = 'invite-no-session'
  const invitedEmail = 'no-session@example.com'
  await installInvitationApiMocks(page, {
    token,
    invitation: {
      accountId: 'account-no-session',
      email: invitedEmail,
      status: 'pending',
      expiresAt: nowIso,
      requiresExistingPassword: false,
      federatedProviders: [],
    },
    session: null,
  })

  await page.goto(`/invite/${token}`)

  await expect(page.getByLabel('Email')).toHaveValue(invitedEmail)
  await expect(page.getByText(/Signed in as/)).toHaveCount(0)
})
