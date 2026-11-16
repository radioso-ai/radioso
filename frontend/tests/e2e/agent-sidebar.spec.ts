import { expect, test, type Page } from '@playwright/test'

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  type RoutineFixture,
  workspaceKey,
} from './dashboard-fixtures'

const secondaryAgentId = '77bcb0c8-caad-4a1b-9fef-70cbca3f7d12'
const agentUrl = `/w/${workspaceKey}/agents/${defaultAgentId}`
const routineId = '55555555-5555-4555-8555-000000000001'

const sidebar = (page: Page) => page.locator('[data-sidebar="sidebar"]')
type Row = 'Build' | 'Test' | 'Channels'
const row = (page: Page, name: Row) => sidebar(page).getByRole('link', { name: new RegExp(`^${name}\\b`) })

const expectOnlyRowCurrent = async (page: Page, current: Row) => {
  for (const name of ['Build', 'Test', 'Channels'] as const) {
    if (name === current) await expect(row(page, name)).toHaveAttribute('aria-current', 'page')
    else await expect(row(page, name)).not.toHaveAttribute('aria-current')
  }
}

const switcher = (page: Page, name: string) => sidebar(page).getByRole('button', { name, exact: true })

const secondaryAgent = { settings: { id: secondaryAgentId, name: 'Sales', internalName: 'sales', isDefault: false } }

const routine: RoutineFixture = {
  id: routineId,
  lineageId: routineId,
  agentId: defaultAgentId,
  name: 'Collect pricing intake',
  enabled: true,
  version: 1,
  activation: { triggerDescription: 'Visitor asks about pricing.', gateRef: null, priority: 20, reentryMode: 'once_per_conversation' },
  slots: [],
  steps: [{ stableStepId: 'ask', kind: 'chat', instruction: 'Ask for the visitor email.', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
  transitions: [{ fromStep: 'ask', toRef: 'done', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
  terminals: [{ stableStepId: 'done', kind: 'complete', instruction: 'Done.', ordinal: 0 }],
  createdAt: nowIso,
  updatedAt: nowIso,
}

test.beforeEach(async ({ page }) => {
  await seedDashboardStorage(page)
})

test('the agent menu highlights Build on every Build page, including a routine', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), routines: [routine] })

  const buildPages = [
    agentUrl,
    `${agentUrl}?tab=behavior&anchor=assistant-profile`,
    `${agentUrl}?tab=behavior&anchor=assistant-directives`,
    `${agentUrl}?tab=behavior&anchor=assistant-routines`,
    `${agentUrl}/routines/${routineId}`,
    `${agentUrl}?tab=behavior&anchor=assistant-skills`,
    `${agentUrl}?tab=behavior&anchor=assistant-context-variables`,
  ]
  for (const url of buildPages) {
    await page.goto(url)
    await expect(sidebar(page).getByRole('button', { name: 'Marta', exact: true })).toBeVisible()
    await expectOnlyRowCurrent(page, 'Build')
  }

  // The Build tab bar carries the five drafted sections and no Test chat.
  await page.goto(agentUrl)
  await expect(page.getByRole('navigation', { name: 'Agent cockpit' }).getByRole('tab')).toHaveText(['Profile', 'Directives', 'Routines', 'Skills', 'Context'])
})

test('an agent opens on Build, Profile', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.goto(agentUrl)

  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await expectOnlyRowCurrent(page, 'Build')
})

test('the agent menu highlights Test on the chat, its history and a saved test, and keeps Test free of a tab bar', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  for (const url of [
    `${agentUrl}?tab=chat`,
    `${agentUrl}?tab=chat&view=history`,
    // A saved-test link made before Test had its own tab names no tab, and still opens the chat.
    `${agentUrl}?testExecution=11111111-1111-4111-8111-111111111111`,
  ]) {
    await page.goto(url)
    await expectOnlyRowCurrent(page, 'Test')
    await expect(page.getByRole('navigation', { name: 'Agent cockpit' })).toHaveCount(0)
  }
})

test('the agent menu highlights Channels on the overview and on every channel page', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  for (const url of [
    `${agentUrl}?tab=channels`,
    `${agentUrl}?tab=channels&anchor=web-chat`,
    `${agentUrl}?tab=channels&anchor=api-channel`,
    `${agentUrl}?tab=channels&anchor=mcp-channel`,
    `${agentUrl}?tab=channels&anchor=slack-channel`,
    `${agentUrl}?tab=channels&anchor=whatsapp-channel`,
  ]) {
    await page.goto(url)
    await expectOnlyRowCurrent(page, 'Channels')
  }
})

test('Build shows a dot while the draft has unpublished changes, and not once it matches live', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.goto(agentUrl)
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await expect(row(page, 'Build')).toHaveAccessibleName('Build')

  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revision-state`, async (route) => {
    await route.fulfill({
      json: {
        agentId: defaultAgentId,
        status: 'draft_dirty',
        draft: { generation: 2, basePublishedRevisionId: null, updatedAt: nowIso },
        publishedRevision: null,
        canPublish: true,
      },
    })
  })
  await page.goto(agentUrl)
  await expect(row(page, 'Build')).toHaveAccessibleName('Build Unpublished changes')
})

test('the Channels row counts the channels that are on', async ({ page }) => {
  const settings = basePlatformSettings()
  settings.channels.anonymousChatEnabled = true
  await installDashboardApiMocks(page, {
    platformSettings: settings,
    agentChannelCredentials: [
      { id: 'rest-credential', audience: 'rest', label: 'REST', prefix: 'rd_rest', status: 'active', createdAt: nowIso, expiresAt: nowIso, lastUsedAt: null, revokedAt: null },
    ],
  })
  await page.route('**/backend/api/v1/connectors/whatsapp', async (route) => {
    await route.fulfill({ json: { id: 'whatsapp', name: 'WhatsApp', description: 'WhatsApp', enabled: false, errorStatus: null, supportsManualSync: false, schema: [], config: {}, webhookUrl: '', syncState: {} } })
  })
  await page.goto(agentUrl)
  await expect(row(page, 'Channels')).toContainText('2 on')
})

test('the Channels row says Needs setup when a channel cannot serve', async ({ page }) => {
  // Slack is bound to this agent, but its app lost access.
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    slackStatus: { status: 'needs_reauth', readiness: { configured: true, missingEnvVars: [] }, teamName: 'Radioso' },
    slackBinding: { channelId: null, answeringAgentId: defaultAgentId, escalationChannelId: null, gapEscalationEnabled: false, respondMode: 'mention' },
  })
  await page.goto(agentUrl)
  await expect(row(page, 'Channels')).toContainText('Needs setup')
})

test('the Channels overview groups every channel by what needs doing', async ({ page }) => {
  const settings = basePlatformSettings()
  settings.channels.anonymousChatEnabled = true
  await installDashboardApiMocks(page, {
    platformSettings: settings,
    agentChannelCredentials: [
      { id: 'rest-credential', audience: 'rest', label: 'REST', prefix: 'rd_rest', status: 'active', createdAt: nowIso, expiresAt: nowIso, lastUsedAt: null, revokedAt: null },
    ],
    slackStatus: { status: 'needs_reauth', readiness: { configured: true, missingEnvVars: [] }, teamName: 'Radioso' },
    slackBinding: { channelId: null, answeringAgentId: defaultAgentId, escalationChannelId: null, gapEscalationEnabled: false, respondMode: 'mention' },
  })
  await page.route('**/backend/api/v1/connectors/whatsapp', async (route) => {
    await route.fulfill({ json: { id: 'whatsapp', name: 'WhatsApp', description: 'WhatsApp', enabled: false, errorStatus: null, supportsManualSync: false, schema: [], config: {}, webhookUrl: '', syncState: {} } })
  })
  await page.goto(`${agentUrl}?tab=channels`)

  await expect(page.getByRole('heading', { name: 'Channels', level: 1, exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Needs setup · 1' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'On · 2' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Not set up · 2' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Fix Slack' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage Web chat' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage Agent API' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Set up MCP' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Set up WhatsApp' })).toBeVisible()
  // The retired "Available" word names nothing any more.
  await expect(page.getByText('Available', { exact: true })).toHaveCount(0)

  await page.getByRole('link', { name: 'Fix Slack' }).click()
  await expect(page).toHaveURL(/tab=channels&anchor=slack-channel/)
  await expect(page.getByRole('heading', { name: 'Slack', level: 1, exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Channels', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Channels', level: 1, exact: true })).toBeVisible()
})

test('WhatsApp is shared across the workspace and counts only for the agent that answers it', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.route('**/backend/api/v1/connectors/whatsapp', async (route) => {
    await route.fulfill({ json: { id: 'whatsapp', name: 'WhatsApp', description: 'WhatsApp', enabled: true, errorStatus: null, supportsManualSync: false, schema: [], config: {}, webhookUrl: '', syncState: {} } })
  })

  await page.goto(`${agentUrl}?tab=channels`)
  await expect(row(page, 'Channels')).toContainText('1 on')
  await expect(page.getByText('Shared across the workspace. This agent answers it.')).toBeVisible()

  await page.goto(`/w/${workspaceKey}/agents/${secondaryAgentId}?tab=channels`)
  await expect(row(page, 'Channels')).toContainText('0 on')
  await expect(page.getByText('Shared across the workspace. Answered by Marta.')).toBeVisible()
})

test('the agent menu switches agents and keeps the page', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.goto(`${agentUrl}?tab=behavior&anchor=assistant-directives`)

  await switcher(page, 'Marta').click()
  const menu = page.getByRole('menu')
  await expect(menu.getByRole('menuitem', { name: 'Marta' })).toHaveAttribute('aria-current', 'true')
  await expect(menu.getByRole('menuitem', { name: 'sales' })).not.toHaveAttribute('aria-current')
  await menu.getByRole('menuitem', { name: 'sales' }).click()

  await expect(page).toHaveURL(new RegExp(`/agents/${secondaryAgentId}\\?anchor=assistant-directives`))
  await expect(switcher(page, 'sales')).toBeVisible()
  await expectOnlyRowCurrent(page, 'Build')
  // Nothing in the menu is left over from the collapse toggle or the old list under it.
  await expect(sidebar(page).getByRole('button', { name: 'New agent', exact: true })).toHaveCount(0)
})

test('Rename… writes the name the menu shows and the menu takes it at once', async ({ page }) => {
  const agentUpdates: unknown[] = []
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), agentUpdates })
  await page.goto(agentUrl)

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename agent' })
  await expect(dialog.getByLabel('Name')).toHaveValue('Marta')
  await dialog.getByLabel('Name').fill('Marta Prime')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(dialog).toBeHidden()
  await expect.poll(() => agentUpdates).toContainEqual({ name: 'Marta Prime' })
  await expect(switcher(page, 'Marta Prime')).toBeVisible()
})

test('Delete agent… asks for the agent name before it deletes, and refuses the only agent', async ({ page }) => {
  const deletes: string[] = []
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deletes.push(route.request().url())
    await route.fulfill({ status: 204, body: '' })
  })
  await page.goto(`${agentUrl}?tab=chat`)

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'Delete agent…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete agent' })
  const confirm = dialog.getByRole('button', { name: 'Delete agent' })
  await expect(confirm).toBeDisabled()
  // The page behind the confirmation is the one the operator was on.
  await expect(page).toHaveURL(/tab=chat/)
  await dialog.getByLabel('Type Marta to confirm').fill('Marta')
  await confirm.click()
  await expect.poll(() => deletes).toHaveLength(1)
})

test('Delete agent… tells the operator why the only agent cannot go', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.goto(agentUrl)

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'Delete agent…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete agent' })
  await expect(dialog.getByText('You cannot delete your only agent in this workspace.')).toBeVisible()
  await expect(dialog.getByLabel('Type Marta to confirm')).toBeDisabled()
})

test('the old Danger zone link opens Profile with the delete confirmation', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.goto(`${agentUrl}?tab=behavior&anchor=agent-danger-zone`)

  const dialog = page.getByRole('dialog', { name: 'Delete agent' })
  await expect(dialog).toBeVisible()

  // Closing the confirmation leaves the operator on Profile, with the anchor gone from the URL.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(page).not.toHaveURL(/agent-danger-zone/)
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await expectOnlyRowCurrent(page, 'Build')
})

test('old channel links open their channel page', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  await page.goto(`${agentUrl}?tab=channels&anchor=website-embed`)
  await expect(page.getByRole('heading', { name: 'Web chat', level: 1, exact: true })).toBeVisible()
  await expectOnlyRowCurrent(page, 'Channels')

  await page.goto(`${agentUrl}?tab=channels&anchor=mcp-channel`)
  await expect(page.getByRole('heading', { name: 'MCP', level: 1, exact: true })).toBeVisible()
})

test('the agent menu offers New agent and Import a bundle', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.goto(agentUrl)

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'New agent' }).click()
  await expect(page.getByRole('heading', { name: 'Create agent', exact: true })).toBeVisible()
  await expect(page.getByTestId('create-agent-import-option')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create manually', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'Import a bundle' }).click()
  await expect(page.getByRole('dialog', { name: /import/i })).toBeVisible()
})

test('Export bundle in the agent menu downloads the agent', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.route('**/backend/api/v1/agents/*/bundle', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    await route.fulfill({ json: { format: 'radioso.agent-bundle', version: 1, agent: { name: 'Marta' } } })
  })
  await page.goto(agentUrl)

  await switcher(page, 'Marta').click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Export bundle' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.json$/)
})

test('Versions beside Publish opens the agent versions page from Build and from Test', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })

  await page.goto(agentUrl)
  await page.getByRole('link', { name: 'Versions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agent versions', level: 1, exact: true })).toBeVisible()

  await page.goto(`${agentUrl}?tab=chat`)
  await page.getByRole('link', { name: 'Versions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Agent versions', level: 1, exact: true })).toBeVisible()
})
