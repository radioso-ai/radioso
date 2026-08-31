import { expect, test } from '@playwright/test'
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
  mcpCredentialSupport: 'unsupported',
})

const personalCredential: ApiCredentialMetadata = {
  id: 'personal-1',
  kind: 'personal',
  label: 'CLI on laptop',
  prefix: 'radioso_pat_ab12',
  roleCeiling: 'member',
  ownerUserId: 'user-1',
  serviceAccountId: null,
  createdByUserId: 'user-1',
  createdAt: '2026-08-31T00:00:00.000Z',
  expiresAt: '2026-09-30T00:00:00.000Z',
  expiryWarningDays: 30,
  lastUsedAt: null,
  revokedAt: null,
  revokedByUserId: null,
  revocationReason: null,
  revision: 1,
  rotatedFromCredentialId: null,
}

test('member issues, revokes, and pages personal tokens without storing the one-time secret', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  const existingTokens = Array.from({ length: 51 }, (_, index): ApiCredentialMetadata => ({
    ...personalCredential,
    id: `existing-${index + 1}`,
    label: `Existing personal token ${index + 1}`,
    prefix: `radioso_pat_existing_${index + 1}`,
  }))
  let issuedToken: ApiCredentialMetadata | null = null
  const requests: string[] = []
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    requests.push(`${request.method()} ${url.pathname}${url.search}`)
    if (request.method() === 'GET' && path.endsWith('/api-access')) {
      await route.fulfill({ json: summary('member') })
      return
    }
    if (request.method() === 'GET' && path.endsWith('/personal-tokens')) {
      const items = issuedToken ? [issuedToken, ...existingTokens] : existingTokens
      const pageNumber = Number(url.searchParams.get('page') ?? '1')
      await route.fulfill({ json: { items: items.slice((pageNumber - 1) * 50, pageNumber * 50), page: pageNumber, limit: 50, total: items.length } })
      return
    }
    if (request.method() === 'POST' && path.endsWith('/personal-tokens')) {
      issuedToken = personalCredential
      await route.fulfill({ status: 201, json: { credential: issuedToken, secret: 'radioso_pat_one_time_secret' } })
      return
    }
    if (request.method() === 'POST' && path.endsWith('/personal-tokens/personal-1/revoke')) {
      issuedToken = { ...personalCredential, revokedAt: '2026-08-31T01:00:00.000Z', revision: 2 }
      await route.fulfill({ json: issuedToken })
      return
    }
    await route.continue()
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=workspace&anchor=api-access`)
  await expect(page.getByRole('heading', { name: 'API access' })).toBeVisible()
  await expect(page.getByText(/breaking change/i)).toBeVisible()

  await page.getByRole('button', { name: /create personal token/i }).click()
  await page.getByLabel(/token label/i).fill('CLI on laptop')
  await page.getByLabel(/expires/i).first().fill('2026-09-30')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: /issue personal token/i }).click()

  await expect(page.getByText('radioso_pat_one_time_secret')).toBeVisible()
  await expect(page.getByRole('dialog').getByText(/cannot be recovered/i).first()).toBeVisible()
  await page.getByRole('checkbox', { name: /cannot be recovered/i }).check()
  await page.getByRole('button', { name: /done|acknowledge/i }).click()
  await expect(page.getByText('radioso_pat_one_time_secret')).toHaveCount(0)

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByText('CLI on laptop').locator('xpath=../..').getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByText('CLI on laptop').locator('xpath=../..').getByRole('button', { name: 'Revoked' })).toBeVisible()

  await expect(page.getByText('Page 1 of 2')).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByText('Existing personal token 50')).toBeVisible()
  expect(requests).toContain('GET /backend/api/v1/account/workspaces/workspace-1/api-access/personal-tokens?view=mine&page=2')
  expect(requests).toContain('POST /backend/api/v1/account/workspaces/workspace-1/api-access/personal-tokens/personal-1/revoke')
  expect(requests.some((request) => request.includes('/service-accounts'))).toBe(false)
  await expect(page.getByRole('heading', { name: 'Service accounts' })).toHaveCount(0)

  const storage = await page.evaluate(() => ({
    workspaceTokens: window.localStorage.getItem('radioso.workspaceTokens'),
    apiToken: window.localStorage.getItem('radioso.apiToken'),
    sessionTokens: Object.keys(window.sessionStorage).filter((key) => /token|secret/i.test(key)),
  }))
  expect(storage).toEqual({ workspaceTokens: null, apiToken: null, sessionTokens: [] })
})

test('administrator audits workspace personal tokens without gaining another user’s rename or rotation authority', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  const ownToken: ApiCredentialMetadata = {
    ...personalCredential,
    id: 'personal-own',
    label: 'My deployment token',
    createdAt: '2026-08-30T00:00:00.000Z',
  }
  const colleagueToken: ApiCredentialMetadata = {
    ...personalCredential,
    id: 'personal-colleague',
    label: 'Colleague laptop',
    ownerUserId: 'user-2',
    createdByUserId: 'user-3',
    roleCeiling: 'admin',
    createdAt: '2026-08-29T00:00:00.000Z',
  }
  const revokedToken: ApiCredentialMetadata = {
    ...colleagueToken,
    id: 'personal-revoked',
    label: 'Rotated colleague token',
    revokedAt: '2026-08-30T00:00:00.000Z',
    revokedByUserId: 'user-1',
    revocationReason: 'rotated',
    rotatedFromCredentialId: 'personal-previous',
  }
  const requests: string[] = []
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    requests.push(`${request.method()} ${url.pathname}${url.search}`)
    if (request.method() === 'GET' && url.pathname.endsWith('/api-access')) {
      await route.fulfill({ json: summary('admin') })
      return
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/personal-tokens')) {
      await route.fulfill({ json: { items: [ownToken, colleagueToken, revokedToken], page: 1, limit: 50, total: 3 } })
      return
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/personal-tokens/personal-colleague/revoke')) {
      await route.fulfill({ json: colleagueToken })
      return
    }
    await route.fulfill({ status: 404, json: { error: { message: `Unhandled API access request: ${request.method()} ${url.pathname}` } } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=workspace&anchor=api-access`)
  await expect(page.getByText('My deployment token')).toBeVisible()
  await expect(page.getByText('Colleague laptop')).toBeVisible()

  const ownRow = page.getByText('My deployment token').locator('xpath=../..')
  await expect(ownRow.getByRole('button', { name: 'Rename' })).toBeVisible()
  await expect(ownRow.getByRole('button', { name: 'Rotate' })).toBeVisible()
  await expect(ownRow.getByRole('button', { name: 'Revoke' })).toBeVisible()

  const colleagueRow = page.getByText('Colleague laptop').locator('xpath=../..')
  await expect(colleagueRow.getByText('Owner user-2')).toBeVisible()
  await expect(colleagueRow.getByText('Role ceiling admin')).toBeVisible()
  await expect(colleagueRow.getByText('Created by user-3')).toBeVisible()
  await expect(colleagueRow.getByText('Status Not revoked')).toBeVisible()
  await expect(colleagueRow.getByText('Created 8/29/2026')).toBeVisible()
  await expect(colleagueRow.getByRole('button', { name: 'Rename' })).toHaveCount(0)
  await expect(colleagueRow.getByRole('button', { name: 'Rotate' })).toHaveCount(0)
  await expect(colleagueRow.getByRole('button', { name: 'Revoke' })).toBeVisible()

  const revokedRow = page.getByText('Rotated colleague token').locator('xpath=../..')
  await expect(revokedRow.getByText('Owner user-2')).toBeVisible()
  await expect(revokedRow.getByText('Role ceiling admin')).toBeVisible()
  await expect(revokedRow.getByText('Created by user-3')).toBeVisible()
  await expect(revokedRow.getByText('Created 8/29/2026')).toBeVisible()
  await expect(revokedRow.getByText('Revoked by user-1')).toBeVisible()
  await expect(revokedRow.getByText('Rotated from personal-previous')).toBeVisible()
  await expect(revokedRow.getByText('Status Revoked')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await colleagueRow.getByRole('button', { name: 'Revoke' }).click()
  expect(requests).toContain('POST /backend/api/v1/account/workspaces/workspace-1/api-access/personal-tokens/personal-colleague/revoke')
})

test('one-time secret uses a labelled modal dialog that traps focus until acknowledgement', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.endsWith('/api-access')) return route.fulfill({ json: summary('member') })
    if (request.method() === 'GET' && path.endsWith('/personal-tokens')) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
    if (request.method() === 'POST' && path.endsWith('/personal-tokens')) return route.fulfill({ status: 201, json: { credential: personalCredential, secret: 'radioso_pat_modal_secret' } })
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled API access request: ${request.method()} ${path}` } } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=workspace&anchor=api-access`)
  await page.getByRole('button', { name: /create personal token/i }).click()
  await page.getByLabel(/token label/i).fill('Modal token')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: /issue personal token/i }).click()

  const dialog = page.getByRole('dialog', { name: 'Save this secret now' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Copy one-time credential secret' })).toBeFocused()
  await dialog.getByRole('checkbox', { name: /cannot be recovered/i }).check()
  await dialog.getByRole('button', { name: 'Done' }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: 'Copy one-time credential secret' })).toBeFocused()
})

test('administrator manages the service-account and credential lifecycle', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  let serviceAccount: ServiceAccountSummary = {
    id: 'service-1', displayName: 'Nightly ingestion', role: 'member', status: 'enabled',
    createdByUserId: 'user-1', createdAt: '2026-08-31T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
    lastUsedAt: null, activeCredentialCount: 1, revision: 1,
  }
  const initialCredential: ApiCredentialMetadata = {
    ...personalCredential,
    id: 'service-credential-1',
    kind: 'service',
    label: 'Initial credential',
    prefix: 'radioso_svc_initial',
    roleCeiling: null,
    ownerUserId: null,
    serviceAccountId: serviceAccount.id,
  }
  let serviceAccounts: ServiceAccountSummary[] = []
  let credentials: ApiCredentialMetadata[] = []
  const requests: Array<{ method: string; path: string; body?: unknown }> = []
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    requests.push({ method: request.method(), path, body: request.postData() ? request.postDataJSON() : undefined })
    if (request.method() === 'GET' && path.endsWith('/api-access')) return route.fulfill({ json: summary() })
    if (request.method() === 'GET' && path.endsWith('/personal-tokens')) return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
    if (request.method() === 'GET' && path.endsWith('/service-accounts')) return route.fulfill({ json: { items: serviceAccounts, page: 1, limit: 50, total: serviceAccounts.length } })
    if (request.method() === 'POST' && path.endsWith('/service-accounts')) {
      serviceAccounts = [serviceAccount]
      credentials = [initialCredential]
      return route.fulfill({ status: 201, json: { serviceAccount, credential: initialCredential, secret: 'radioso_svc_first_secret' } })
    }
    if (request.method() === 'GET' && path.endsWith('/credentials')) return route.fulfill({ json: { items: credentials, page: 1, limit: 50, total: credentials.length } })
    if (request.method() === 'GET' && path.endsWith('/service-1')) return route.fulfill({ json: serviceAccount })
    if (request.method() === 'POST' && path.endsWith('/credentials')) {
      const issued: ApiCredentialMetadata = { ...initialCredential, id: 'service-credential-2', label: 'Canary runner', prefix: 'radioso_svc_canary', revision: 1 }
      credentials = [issued, ...credentials]
      serviceAccount = { ...serviceAccount, activeCredentialCount: 2, revision: serviceAccount.revision + 1 }
      return route.fulfill({ status: 201, json: { credential: issued, secret: 'radioso_svc_canary_secret' } })
    }
    if (request.method() === 'PATCH' && path.endsWith('/service-1')) {
      const body = request.postDataJSON() as { role: 'member' | 'admin'; revision: number }
      serviceAccount = { ...serviceAccount, role: body.role, revision: serviceAccount.revision + 1 }
      return route.fulfill({ json: serviceAccount })
    }
    if (request.method() === 'POST' && /\/service-1\/(disable|enable|archive)$/.test(path)) {
      const action = path.split('/').at(-1) as 'disable' | 'enable' | 'archive'
      serviceAccount = { ...serviceAccount, status: action === 'disable' ? 'disabled' : action === 'enable' ? 'enabled' : 'archived', revision: serviceAccount.revision + 1 }
      return route.fulfill({ json: serviceAccount })
    }
    if (request.method() === 'PATCH' && /\/credentials\/service-credential-1$/.test(path)) {
      const body = request.postDataJSON() as { label: string }
      credentials = credentials.map((credential) => credential.id === 'service-credential-1' ? { ...credential, label: body.label, revision: credential.revision + 1 } : credential)
      return route.fulfill({ json: credentials.find((credential) => credential.id === 'service-credential-1') })
    }
    if (request.method() === 'POST' && /\/credentials\/service-credential-1\/rotate$/.test(path)) {
      const predecessor = credentials.find((credential) => credential.id === 'service-credential-1')!
      const replacement = { ...predecessor, id: 'service-credential-3', prefix: 'radioso_svc_rotated', revision: 1, rotatedFromCredentialId: predecessor.id }
      credentials = [replacement, ...credentials.map((credential) => credential.id === predecessor.id ? { ...credential, revokedAt: '2026-08-31T01:00:00.000Z', revision: credential.revision + 1 } : credential)]
      return route.fulfill({ status: 201, json: { credential: replacement, secret: 'radioso_svc_rotated_secret' } })
    }
    if (request.method() === 'POST' && /\/credentials\/service-credential-2\/revoke$/.test(path)) {
      credentials = credentials.map((credential) => credential.id === 'service-credential-2' ? { ...credential, revokedAt: '2026-08-31T01:00:00.000Z', revision: credential.revision + 1 } : credential)
      return route.fulfill({ json: credentials.find((credential) => credential.id === 'service-credential-2') })
    }
    return route.fulfill({ status: 404, json: { error: { message: `Unhandled API access request: ${request.method()} ${path}` } } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=workspace&anchor=api-access`)
  await expect(page.getByRole('heading', { name: 'Service accounts' })).toBeVisible()
  await page.getByRole('button', { name: /new service account|create service account/i }).click()
  await page.getByLabel('Service account name').fill('Nightly ingestion')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: /create service account/i }).click()

  await expect(page.getByText('radioso_svc_first_secret')).toBeVisible()
  await page.getByRole('checkbox', { name: /cannot be recovered/i }).check()
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: 'Manage credentials' }).click()
  await expect(page.getByRole('heading', { name: 'Nightly ingestion credentials' })).toBeVisible()
  await page.getByLabel('Credential label').fill('Canary runner')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Issue credential' }).click()
  await expect(page.getByText('radioso_svc_canary_secret')).toBeVisible()
  await page.getByRole('checkbox', { name: /cannot be recovered/i }).check()
  await page.getByRole('button', { name: 'Done' }).click()

  page.once('dialog', (dialog) => dialog.accept('Production runner'))
  await page.getByText('Initial credential').locator('xpath=../..').getByRole('button', { name: 'Rename' }).click()
  await expect(page.getByText('Production runner')).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByText('Production runner').locator('xpath=../..').getByRole('button', { name: 'Rotate' }).click()
  await expect(page.getByText('radioso_svc_rotated_secret')).toBeVisible()
  await page.getByRole('checkbox', { name: /cannot be recovered/i }).check()
  await page.getByRole('button', { name: 'Done' }).click()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByText('Canary runner').locator('xpath=../..').getByRole('button', { name: 'Revoke' }).click()
  await expect(page.getByText('Canary runner').locator('xpath=../..').getByRole('button', { name: 'Revoked' })).toBeVisible()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByLabel('Live role').selectOption('admin')
  await expect(page.getByLabel('Live role')).toHaveValue('admin')

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Disable' }).click()
  await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Enable' }).click()
  await expect(page.getByRole('button', { name: 'Disable' })).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0)

  expect(requests).toEqual(expect.arrayContaining([
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-accounts$/) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/credentials$/) }),
    expect.objectContaining({ method: 'PATCH', path: expect.stringMatching(/credentials\/service-credential-1$/), body: expect.objectContaining({ label: 'Production runner' }) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/credentials\/service-credential-1\/rotate$/) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/credentials\/service-credential-2\/revoke$/) }),
    expect.objectContaining({ method: 'PATCH', path: expect.stringMatching(/\/service-1$/), body: expect.objectContaining({ role: 'admin' }) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-1\/disable$/) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-1\/enable$/) }),
    expect.objectContaining({ method: 'POST', path: expect.stringMatching(/\/service-1\/archive$/) }),
  ]))
})
