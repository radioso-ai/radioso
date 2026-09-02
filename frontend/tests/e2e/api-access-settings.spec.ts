import { expect, test, type Page } from '@playwright/test'
import type { ApiCredentialMetadata, ServiceAccountSummary } from '@/lib/api'

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

const summary = (role: 'member' | 'admin' = 'admin') => ({
  effectiveRole: role,
  capabilities: {
    manageOwnPersonalTokens: true,
    auditWorkspacePersonalTokens: role === 'admin',
    manageServiceAccounts: role === 'admin',
  },
  defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
  limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
  legacyCredentialMigration: { status: 'destroyed', migratedAt: '2026-08-31T00:00:00.000Z' },
})

const personalCredential: ApiCredentialMetadata = {
  id: 'personal-1',
  kind: 'personal',
  label: 'CLI on laptop',
  prefix: 'radioso_pat_ab12',
  roleCeiling: 'member',
  status: 'active',
  ownerUserId: 'user-1',
  serviceAccountId: null,
  createdByUserId: 'user-1',
  createdAt: '2026-08-31T12:00:00.000Z',
  expiresAt: null,
  expiryWarningDays: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null,
  revision: 1,
  rotatedFromCredentialId: null,
}

/** The one-time secret is only ever released through an acknowledged Done. */
const acknowledgeSecret = async (page: Page, secret: string) => {
  const dialog = page.getByRole('dialog', { name: 'Credential issued' })
  await expect(dialog.getByText(secret)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Done' })).toBeDisabled()
  await dialog.getByRole('checkbox').check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await expect(page.getByText(secret)).toHaveCount(0)
}

test('member creates and revokes a personal token without touching service accounts', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  let tokens: ApiCredentialMetadata[] = []
  const requests: string[] = []
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    requests.push(`${request.method()} ${path}${url.search}`)
    if (request.method() === 'GET' && path.endsWith('/api-access')) {
      return route.fulfill({ json: summary('member') })
    }
    if (request.method() === 'GET' && path.endsWith('/personal-tokens')) {
      return route.fulfill({ json: { items: tokens, page: 1, limit: 50, total: tokens.length } })
    }
    if (request.method() === 'POST' && path.endsWith('/personal-tokens')) {
      const body = request.postDataJSON() as { expiresAt: string }
      tokens = [{ ...personalCredential, expiresAt: body.expiresAt }]
      return route.fulfill({ status: 201, json: { credential: tokens[0], secret: 'radioso_pat_one_time_secret' } })
    }
    if (request.method() === 'POST' && path.endsWith('/personal-tokens/personal-1/revoke')) {
      tokens = tokens.map((token) => ({ ...token, status: 'revoked', revokedAt: '2026-08-31T13:00:00.000Z', revision: 2 }))
      return route.fulfill({ json: tokens[0] })
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled: ${request.method()} ${path}` } } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=api-access`)
  await expect(page.getByRole('heading', { name: 'API access', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Personal tokens', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Service accounts' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Members’ personal tokens' })).toHaveCount(0)

  await page.locator('#personal-tokens').getByRole('button', { name: 'Create token' }).click()
  const createDialog = page.getByRole('dialog', { name: 'Create token' })
  await createDialog.getByLabel('Label', { exact: true }).fill('CLI on laptop')
  await expect(createDialog.getByLabel('Expires')).not.toHaveValue('')
  await createDialog.getByRole('button', { name: 'Create token' }).click()

  // Escape must not be a way to walk away from a secret that exists nowhere else.
  await expect(page.getByRole('dialog', { name: 'Credential issued' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Credential issued' })).toBeVisible()
  await acknowledgeSecret(page, 'radioso_pat_one_time_secret')

  await expect(page.getByText('CLI on laptop')).toBeVisible()
  await page.getByRole('button', { name: 'Actions for CLI on laptop' }).click()
  await expect(page.getByRole('menuitem', { name: 'Details' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Rotate' })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Revoke' }).click()

  const revokeConfirm = page.getByRole('alertdialog')
  await expect(revokeConfirm.getByText('radioso_pat_ab12', { exact: false })).toBeVisible()
  await revokeConfirm.getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible()

  expect(requests).toContain('POST /backend/api/v1/account/workspaces/workspace-1/api-access/personal-tokens/personal-1/revoke')
  expect(requests.some((request) => request.includes('/service-accounts'))).toBe(false)

  const storage = await page.evaluate(() => ({
    workspaceTokens: window.localStorage.getItem('radioso.workspaceTokens'),
    apiToken: window.localStorage.getItem('radioso.apiToken'),
    sessionTokens: Object.keys(window.sessionStorage).filter((key) => /token|secret/i.test(key)),
  }))
  expect(storage).toEqual({ workspaceTokens: null, apiToken: null, sessionTokens: [] })
})

test('the old service accounts deep link lands on the API access tab', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.endsWith('/api-access')) return route.fulfill({ json: summary() })
    if (request.method() === 'GET' && path.endsWith('/personal-tokens')) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
    if (request.method() === 'GET' && path.endsWith('/service-accounts')) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled: ${request.method()} ${path}` } } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=service-accounts`)

  await expect(page.getByRole('heading', { name: 'API access', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Personal tokens', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Service accounts' })).toBeVisible()
})

test('administrator manages a service account from the detail sheet', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  let account: ServiceAccountSummary = {
    id: 'service-1', displayName: 'Nightly ingestion', role: 'member', status: 'enabled',
    createdByUserId: 'user-1', createdAt: '2026-08-31T12:00:00.000Z', updatedAt: '2026-08-31T12:00:00.000Z',
    disabledAt: null, archivedAt: null, lastUsedAt: null, activeCredentialCount: 1, revision: 1,
  }
  const primaryCredential: ApiCredentialMetadata = {
    ...personalCredential,
    id: 'service-credential-1',
    kind: 'service',
    label: 'Primary',
    prefix: 'radioso_svc_initial',
    roleCeiling: null,
    ownerUserId: null,
    serviceAccountId: 'service-1',
    expiresAt: '2027-08-31T12:00:00.000Z',
  }
  let accounts: ServiceAccountSummary[] = []
  let credentials: ApiCredentialMetadata[] = []
  const requests: Array<{ method: string; path: string; body?: unknown }> = []

  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push({ method: request.method(), path, body: request.postData() ? request.postDataJSON() : undefined })
    if (request.method() === 'GET' && path.endsWith('/api-access')) return route.fulfill({ json: summary() })
    if (request.method() === 'GET' && path.endsWith('/personal-tokens')) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
    if (request.method() === 'GET' && path.endsWith('/service-accounts')) return route.fulfill({ json: { items: accounts, page: 1, limit: 50, total: accounts.length } })
    if (request.method() === 'POST' && path.endsWith('/service-accounts')) {
      accounts = [account]
      credentials = [primaryCredential]
      return route.fulfill({ status: 201, json: { serviceAccount: account, credential: primaryCredential, secret: 'radioso_svc_first_secret' } })
    }
    if (request.method() === 'GET' && path.endsWith('/service-1')) return route.fulfill({ json: account })
    if (request.method() === 'GET' && path.endsWith('/credentials')) return route.fulfill({ json: { items: credentials, page: 1, limit: 50, total: credentials.length } })
    if (request.method() === 'POST' && path.endsWith('/credentials')) {
      const issued: ApiCredentialMetadata = { ...primaryCredential, id: 'service-credential-2', label: 'Canary runner', prefix: 'radioso_svc_canary', revision: 1 }
      credentials = [issued, ...credentials]
      account = { ...account, activeCredentialCount: 2, revision: account.revision + 1 }
      accounts = [account]
      return route.fulfill({ status: 201, json: { credential: issued, secret: 'radioso_svc_canary_secret' } })
    }
    if (request.method() === 'PATCH' && path.endsWith('/service-1')) {
      const body = request.postDataJSON() as { displayName?: string; role?: 'member' | 'admin'; revision: number }
      account = {
        ...account,
        ...(body.displayName ? { displayName: body.displayName } : {}),
        ...(body.role ? { role: body.role } : {}),
        revision: account.revision + 1,
        updatedAt: '2026-08-31T13:00:00.000Z',
      }
      accounts = [account]
      return route.fulfill({ json: account })
    }
    if (request.method() === 'POST' && /\/service-1\/(disable|enable|archive)$/.test(path)) {
      const action = path.split('/').at(-1) as 'disable' | 'enable' | 'archive'
      account = {
        ...account,
        status: action === 'disable' ? 'disabled' : action === 'enable' ? 'enabled' : 'archived',
        disabledAt: action === 'disable' ? '2026-08-31T14:00:00.000Z' : account.disabledAt,
        archivedAt: action === 'archive' ? '2026-08-31T15:00:00.000Z' : account.archivedAt,
        revision: account.revision + 1,
      }
      accounts = [account]
      return route.fulfill({ json: account })
    }
    if (request.method() === 'PATCH' && /\/credentials\/service-credential-1$/.test(path)) {
      const body = request.postDataJSON() as { label: string }
      credentials = credentials.map((credential) => credential.id === 'service-credential-1'
        ? { ...credential, label: body.label, revision: credential.revision + 1 }
        : credential)
      return route.fulfill({ json: credentials.find((credential) => credential.id === 'service-credential-1') })
    }
    if (request.method() === 'POST' && /\/credentials\/service-credential-1\/rotate$/.test(path)) {
      const predecessor = credentials.find((credential) => credential.id === 'service-credential-1')!
      const replacement = { ...predecessor, id: 'service-credential-3', prefix: 'radioso_svc_rotated', revision: 1, rotatedFromCredentialId: predecessor.id }
      credentials = [
        replacement,
        ...credentials.map((credential) => credential.id === predecessor.id
          ? { ...credential, status: 'revoked' as const, revokedAt: '2026-08-31T13:00:00.000Z', revision: credential.revision + 1 }
          : credential),
      ]
      return route.fulfill({ status: 201, json: { credential: replacement, secret: 'radioso_svc_rotated_secret' } })
    }
    if (request.method() === 'POST' && /\/credentials\/service-credential-2\/revoke$/.test(path)) {
      credentials = credentials.map((credential) => credential.id === 'service-credential-2'
        ? { ...credential, status: 'revoked' as const, revokedAt: '2026-08-31T13:00:00.000Z', revision: credential.revision + 1 }
        : credential)
      return route.fulfill({ json: credentials.find((credential) => credential.id === 'service-credential-2') })
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled: ${request.method()} ${path}` } } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=api-access`)
  const card = page.locator('#service-accounts')
  await card.getByRole('button', { name: 'New service account' }).click()
  const createDialog = page.getByRole('dialog', { name: 'New service account' })
  await createDialog.getByLabel('Name', { exact: true }).fill('Nightly ingestion')
  await expect(createDialog.getByLabel('Primary credential expires')).not.toHaveValue('')
  await createDialog.getByRole('button', { name: 'Create service account' }).click()
  await acknowledgeSecret(page, 'radioso_svc_first_secret')

  await expect(card.getByText('1 credential · Last used never')).toBeVisible()
  await card.getByRole('button', { name: 'Manage Nightly ingestion' }).click()

  const sheet = page.locator('[data-slot="sheet-content"]')
  await expect(sheet.getByRole('heading', { name: 'Nightly ingestion' })).toBeVisible()
  await expect(sheet.getByText('Created by you', { exact: false })).toBeVisible()

  await sheet.getByRole('button', { name: 'Rename service account' }).click()
  const renameAccount = page.getByRole('dialog', { name: 'Rename service account' })
  await renameAccount.getByLabel('Name', { exact: true }).fill('Production automation')
  await renameAccount.getByRole('button', { name: 'Save' }).click()
  await expect(sheet.getByRole('heading', { name: 'Production automation' })).toBeVisible()

  await sheet.getByLabel('Label', { exact: true }).fill('Canary runner')
  await sheet.getByRole('button', { name: 'Issue' }).click()
  await acknowledgeSecret(page, 'radioso_svc_canary_secret')
  await expect(sheet.getByText('Canary runner')).toBeVisible()

  await sheet.getByRole('button', { name: 'Actions for Primary' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const renameCredential = page.getByRole('dialog', { name: 'Rename credential' })
  await renameCredential.getByLabel('Label', { exact: true }).fill('Production runner')
  await renameCredential.getByRole('button', { name: 'Save' }).click()
  await expect(sheet.getByText('Production runner')).toBeVisible()

  await sheet.getByRole('button', { name: 'Actions for Production runner' }).click()
  await page.getByRole('menuitem', { name: 'Rotate' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Rotate credential' }).click()
  await acknowledgeSecret(page, 'radioso_svc_rotated_secret')

  await sheet.getByRole('button', { name: 'Actions for Canary runner' }).click()
  await page.getByRole('menuitem', { name: 'Revoke' }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke' }).click()
  await expect(sheet.getByText('Revoked', { exact: true }).first()).toBeVisible()

  await sheet.getByLabel('Service account role').selectOption('admin')
  const roleConfirm = page.getByRole('alertdialog')
  await expect(roleConfirm.getByText('gains admin authority on every active credential, immediately.', { exact: false })).toBeVisible()
  await roleConfirm.getByRole('button', { name: 'Change role' }).click()
  await expect(sheet.getByLabel('Service account role')).toHaveValue('admin')

  await sheet.getByRole('button', { name: 'Disable', exact: true }).click()
  await expect(sheet.getByText('Credentials are inert while the account is disabled.')).toBeVisible()
  await sheet.getByRole('button', { name: 'Enable', exact: true }).click()
  await expect(sheet.getByText('Credentials are inert while the account is disabled.')).toHaveCount(0)

  await sheet.getByRole('button', { name: 'Archive', exact: true }).click()
  const archiveConfirm = page.getByRole('alertdialog')
  await expect(archiveConfirm.getByText('Cannot be undone.', { exact: false })).toBeVisible()
  await archiveConfirm.getByRole('button', { name: 'Archive service account' }).click()
  await expect(sheet.getByRole('button', { name: 'Archive', exact: true })).toHaveCount(0)

  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-accounts$/), body: expect.objectContaining({ displayName: 'Nightly ingestion', role: 'member' }) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/credentials$/), body: expect.objectContaining({ label: 'Canary runner' }) }),
    expect.objectContaining({ method: 'PATCH', path: expect.stringMatching(/\/service-1$/), body: expect.objectContaining({ displayName: 'Production automation' }) }),
    expect.objectContaining({ method: 'PATCH', path: expect.stringMatching(/credentials\/service-credential-1$/), body: expect.objectContaining({ label: 'Production runner' }) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/credentials\/service-credential-1\/rotate$/) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/credentials\/service-credential-2\/revoke$/) }),
    expect.objectContaining({ method: 'PATCH', path: expect.stringMatching(/\/service-1$/), body: expect.objectContaining({ role: 'admin' }) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-1\/disable$/) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-1\/enable$/) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-1\/archive$/) }),
  ]))
})

test('administrator revokes a member token from the audit card without gaining rename or rotation', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  const ownToken: ApiCredentialMetadata = { ...personalCredential, id: 'personal-own', label: 'My deployment token' }
  const colleagueToken: ApiCredentialMetadata = {
    ...personalCredential,
    id: 'personal-colleague',
    label: 'CI smoke checks',
    prefix: 'radioso_pat_2mVd',
    ownerUserId: 'user-2',
    createdByUserId: 'user-2',
    expiresAt: new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString(),
    expiryWarningDays: 30,
  }
  const requests: string[] = []

  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    requests.push(`${request.method()} ${path}${url.search}`)
    if (request.method() === 'GET' && path.endsWith('/api-access')) return route.fulfill({ json: summary('admin') })
    if (request.method() === 'GET' && path.endsWith('/personal-tokens')) {
      const view = url.searchParams.get('view')
      const items = view === 'workspace' ? [ownToken, colleagueToken] : [ownToken]
      return route.fulfill({ json: { items, page: 1, limit: 50, total: items.length } })
    }
    if (request.method() === 'GET' && path.endsWith('/service-accounts')) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
    if (request.method() === 'POST' && path.endsWith('/personal-tokens/personal-colleague/revoke')) {
      return route.fulfill({ json: { ...colleagueToken, status: 'revoked' } })
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled: ${request.method()} ${path}` } } })
  })
  await page.route('**/backend/api/v1/account/users', async (route) => route.fulfill({
    json: {
      accountId: 'account-1',
      currentUserId: 'user-1',
      users: [
        { membershipId: 'membership-1', userId: 'user-1', email: 'operator@example.com', role: 'admin', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
        { membershipId: 'membership-2', userId: 'user-2', email: 'marta@example.com', role: 'member', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
      invitations: [],
      workspaceGrants: [],
    },
  }))

  await page.goto(`/w/${workspaceKey}/settings?tab=api-access`)

  const auditCard = page.locator('#member-personal-tokens')
  await expect(auditCard.getByText('CI smoke checks')).toBeVisible()
  await expect(auditCard.getByText('My deployment token')).toHaveCount(0)
  await expect(auditCard.getByText('marta@example.com', { exact: false })).toBeVisible()
  await expect(auditCard.getByText('Expires in 9 days')).toBeVisible()
  await expect(auditCard.getByRole('button', { name: 'Actions for CI smoke checks' })).toHaveCount(0)

  await auditCard.getByRole('button', { name: 'Revoke CI smoke checks' }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm.getByText('owned by marta@example.com', { exact: false })).toBeVisible()
  await confirm.getByRole('button', { name: 'Revoke' }).click()

  expect(requests).toContain('POST /backend/api/v1/account/workspaces/workspace-1/api-access/personal-tokens/personal-colleague/revoke')
})
