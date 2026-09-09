import { expect, test } from '@playwright/test'

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  workspaceKey,
} from './dashboard-fixtures'

const secondaryAgentId = '77bcb0c8-caad-4a1b-9fef-70cbca3f7d12'

test('agent sidebar keeps the selected hierarchy and configured channel catalog', async ({ page }) => {
  await seedDashboardStorage(page)
  const settings = basePlatformSettings()
  settings.channels.anonymousChatEnabled = true
  await installDashboardApiMocks(page, {
    platformSettings: settings,
    agentChannelCredentials: [
      { id: 'rest-credential', audience: 'rest', label: 'REST', prefix: 'rd_rest', status: 'active', createdAt: nowIso, expiresAt: nowIso, lastUsedAt: null, revokedAt: null },
      { id: 'mcp-credential', audience: 'mcp', label: 'MCP', prefix: 'rd_mcp', status: 'active', createdAt: nowIso, expiresAt: nowIso, lastUsedAt: null, revokedAt: null },
    ],
    slackStatus: { status: 'needs_reauth', readiness: { configured: true, missingEnvVars: [] }, teamName: 'Radioso' },
    slackBinding: { channelId: null, answeringAgentId: defaultAgentId, escalationChannelId: null, gapEscalationEnabled: false },
  })
  await page.route('**/backend/api/v1/agents', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const first = {
      id: defaultAgentId,
      workspaceId: 'workspace-1',
      name: 'Marta',
      internalName: '',
      assistantLinkUtmEnabled: true,
      logo: null,
      surfaceSettings: {
        anonymousChat: { enabled: true, token: 'public-token' },
        websiteEmbed: { enabled: false, token: null, allowedOrigins: [], launcherLabel: '', launcherPosition: 'bottom-right', theme: {}, copy: {}, expertOverrides: {} },
      },
    }
    await route.fulfill({ json: { agents: [first, { ...first, id: secondaryAgentId, name: 'Sales', internalName: 'sales', logo: { bucket: 'local', objectPath: 'sales.png', mimeType: 'image/png', filename: 'sales.png', sizeBytes: 12 } }] } })
  })
  await page.route('**/runtime-config', async (route) => {
    await route.fulfill({ json: { mcpUrl: 'https://mcp.example.test', operatorMcpUrl: '', publicApiUrl: '' } })
  })
  await page.route('**/backend/api/v1/connectors/whatsapp', async (route) => {
    await route.fulfill({ json: { id: 'whatsapp', name: 'WhatsApp', description: 'WhatsApp', enabled: false, errorStatus: null, supportsManualSync: false, schema: [], config: {}, webhookUrl: '', syncState: {} } })
  })

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`)
  const sidebar = page.locator('[data-sidebar="sidebar"]')
  await expect(sidebar.getByText('Marta', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('sales', { exact: true })).toBeVisible()

  await sidebar.getByRole('button', { name: 'Channels', exact: true }).click()
  await expect(sidebar.getByText('Web chat', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('Agent API', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('MCP', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('Slack', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('Needs setup', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('Manage channels', { exact: true })).toBeVisible()

  await sidebar.getByRole('button', { name: 'Channels', exact: true }).click()
  await expect(sidebar.getByText('Web chat', { exact: true })).toBeHidden()
})

test('agent sidebar keeps new-agent setup choices under the agent group', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`)

  const sidebar = page.locator('[data-sidebar="sidebar"]')
  await sidebar.getByRole('button', { name: 'New agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create agent', exact: true })).toBeVisible()
  await expect(page.getByTestId('create-agent-import-option')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create manually', exact: true })).toBeVisible()
})

test('Danger zone stays reachable from the agent sidebar', async ({ page }) => {
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`)

  const sidebar = page.locator('[data-sidebar="sidebar"]')
  const dangerZoneLink = sidebar.getByRole('link', { name: 'Danger zone', exact: true })
  await expect(dangerZoneLink).toBeVisible()
  await dangerZoneLink.click()

  await expect(page.getByRole('heading', { name: 'Danger zone', level: 1, exact: true })).toBeVisible()
  await expect(page.getByText('Delete this agent', { exact: true })).toBeVisible()
})

test('Manage channels opens the real channel overview', async ({ page }) => {
  await seedDashboardStorage(page)
  const settings = basePlatformSettings()
  settings.channels.anonymousChatEnabled = true
  await installDashboardApiMocks(page, { platformSettings: settings })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=channels`)
  const sidebar = page.locator('[data-sidebar="sidebar"]')
  await expect(sidebar.getByText('Manage channels', { exact: true })).toBeVisible()
  await sidebar.getByText('Manage channels', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Channels', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Web chat', exact: true })).toBeVisible()
})
