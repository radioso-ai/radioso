import { expect, test } from '@playwright/test'

import type { EventSubscription } from '@/lib/api-event-subscriptions'

import {
  basePlatformSettings,
  installDashboardApiMocks,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

const apiAccessSummary = {
  effectiveRole: 'admin',
  capabilities: { manageOwnPersonalTokens: true, auditWorkspacePersonalTokens: false, manageServiceAccounts: false },
  defaults: { personalTokenLifetimeDays: 90, serviceCredentialLifetimeDays: 365 },
  limits: { personalTokensPerUser: 10, serviceAccountsPerWorkspace: 50, credentialsPerServiceAccount: 5, maximumPageSize: 100 },
  legacyCredentialMigration: { status: 'destroyed', migratedAt: '2026-08-31T00:00:00.000Z' },
}

const zapier: EventSubscription = {
  id: '6f1c2a40-0000-4000-8000-000000000001',
  label: 'zapier',
  targetHost: 'hooks.zapier.example',
  eventTypes: ['routine.completed', 'contact_request.created'],
  status: 'active',
  disabledReason: null,
  createdAt: '2026-11-18T09:00:00.000Z',
  createdBy: { kind: 'service_account', label: 'Zapier connection' },
  lastDelivery: { at: '2026-11-19T08:30:00.000Z', outcome: 'delivered', statusCode: 200 },
  failingSince: null,
}

const n8n: EventSubscription = {
  id: '6f1c2a40-0000-4000-8000-000000000002',
  label: 'n8n',
  targetHost: 'automation.example',
  eventTypes: ['handoff.requested'],
  status: 'disabled',
  disabledReason: 'delivery_failing',
  createdAt: '2026-11-10T09:00:00.000Z',
  createdBy: { kind: 'personal_token', label: 'n8n on the office server' },
  lastDelivery: { at: '2026-11-12T10:00:00.000Z', outcome: 'failed', statusCode: 502 },
  failingSince: '2026-11-11T09:00:00.000Z',
}

test('an operator sees where workspace events go and deletes a subscription that stopped', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api-access')) return route.fulfill({ json: apiAccessSummary })
    return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
  })
  let subscriptions = [zapier, n8n]
  const deletes: string[] = []
  await page.route('**/backend/api/v1/workspace/event-subscriptions**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'GET' && path.endsWith('/event-subscriptions')) {
      return route.fulfill({ json: { subscriptions } })
    }
    if (request.method() === 'DELETE') {
      const id = path.split('/').at(-1)!
      deletes.push(`${id} ${request.headers()['x-workspace-id']}`)
      subscriptions = subscriptions.filter((subscription) => subscription.id !== id)
      return route.fulfill({ status: 204 })
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Unhandled' } } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=api-access`)

  const card = page.locator('#event-subscriptions')
  const rows = card.getByTestId('event-subscription-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toHaveAttribute('data-state', 'active')
  await expect(rows.nth(0)).toContainText('hooks.zapier.example')
  await expect(rows.nth(1)).toHaveAttribute('data-state', 'stopped_failing')
  await expect(rows.nth(1)).toContainText('automation.example')

  await rows.nth(1).getByRole('button', { name: /automation\.example/ }).click()
  const confirm = page.getByRole('alertdialog')
  await confirm.getByRole('button', { name: /delete/i }).click()

  await expect(confirm).toHaveCount(0)
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText('hooks.zapier.example')
  expect(deletes).toEqual([`${n8n.id} workspace-1`])
})

test('a workspace with no subscriptions lists none and shows no error', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.route('**/backend/api/v1/account/workspaces/workspace-1/api-access**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api-access')) return route.fulfill({ json: apiAccessSummary })
    return route.fulfill({ json: { items: [], page: 1, limit: 50, total: 0 } })
  })

  await page.goto(`/w/${workspaceKey}/settings?tab=api-access`)

  const card = page.locator('#event-subscriptions')
  await expect(card.getByTestId('event-subscriptions-empty')).toBeVisible()
  await expect(card.getByTestId('event-subscription-row')).toHaveCount(0)
  await expect(card.getByRole('alert')).toHaveCount(0)
})
