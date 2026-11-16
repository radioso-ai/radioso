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

const whatsappConnector = (enabled: boolean) => ({
  id: 'whatsapp', name: 'WhatsApp', description: 'WhatsApp', enabled, errorStatus: null, supportsManualSync: false, schema: [], config: {}, webhookUrl: '', syncState: {},
})
const mockWhatsapp = (page: Page, enabled: boolean) =>
  page.route('**/backend/api/v1/connectors/whatsapp', (route) => route.fulfill({ json: whatsappConnector(enabled) }))

const group = (page: Page, name: 'needs-setup' | 'on' | 'not-set-up' | 'answered-by-another-agent') => page.getByTestId(`channel-group-${name}`)
const channelRow = (page: Page, id: string) => page.getByTestId(`channel-row-${id}`)

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
  await mockWhatsapp(page, false)
  await page.goto(`${agentUrl}?tab=channels`)

  await expect(page.getByRole('heading', { name: 'Channels', level: 1, exact: true })).toBeVisible()
  await expect(group(page, 'needs-setup').getByTestId('channel-row-slack-channel')).toBeVisible()
  await expect(group(page, 'on').getByTestId('channel-row-web-chat')).toBeVisible()
  await expect(group(page, 'on').getByTestId('channel-row-api-channel')).toBeVisible()
  await expect(group(page, 'not-set-up').getByTestId('channel-row-mcp-channel')).toBeVisible()
  await expect(group(page, 'not-set-up').getByTestId('channel-row-whatsapp-channel')).toBeVisible()
  await expect(page.getByTestId('channel-group-answered-by-another-agent')).toHaveCount(0)
  await expect(page.getByRole('link', { name: 'Fix Slack' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Manage Web chat' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Set up MCP' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Set up WhatsApp' })).toBeVisible()

  await page.getByRole('link', { name: 'Fix Slack' }).click()
  await expect(page).toHaveURL(/tab=channels&anchor=slack-channel/)
  await expect(page.getByRole('heading', { name: 'Slack', level: 1, exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Channels', exact: true }).first().click()
  await expect(page.getByRole('heading', { name: 'Channels', level: 1, exact: true })).toBeVisible()
})

test('Slack is not offered while the deployment has no Slack app', async ({ page }) => {
  await installDashboardApiMocks(page, {
    platformSettings: basePlatformSettings(),
    slackStatus: { status: 'not_configured', readiness: { configured: false, missingEnvVars: ['SLACK_CLIENT_ID'] } },
  })
  await page.goto(`${agentUrl}?tab=channels`)

  await expect(group(page, 'not-set-up').getByTestId('channel-row-api-channel')).toBeVisible()
  await expect(channelRow(page, 'slack-channel')).toHaveCount(0)
})

test('WhatsApp counts for the agent that answers it, and sits in its own group for every other agent', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await mockWhatsapp(page, true)

  await page.goto(`${agentUrl}?tab=channels`)
  await expect(row(page, 'Channels')).toContainText('1 on')
  await expect(group(page, 'on').getByTestId('channel-row-whatsapp-channel')).toBeVisible()

  await page.goto(`/w/${workspaceKey}/agents/${secondaryAgentId}?tab=channels`)
  await expect(group(page, 'answered-by-another-agent').getByTestId('channel-row-whatsapp-channel')).toBeVisible()
  await expect(channelRow(page, 'whatsapp-channel')).toContainText('Marta')
  // It is not this agent's, so it is neither counted nor flagged.
  await expect(row(page, 'Channels')).toContainText('0 on')
  await expect(row(page, 'Channels')).not.toContainText('Needs setup')
})

test('a WhatsApp connection that is broken is not flagged on an agent that does not answer it', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.route('**/backend/api/v1/connectors/whatsapp', (route) => route.fulfill({ json: { ...whatsappConnector(true), errorStatus: 'token_expired' } }))

  await page.goto(`/w/${workspaceKey}/agents/${secondaryAgentId}?tab=channels`)
  await expect(group(page, 'answered-by-another-agent').getByTestId('channel-row-whatsapp-channel')).toBeVisible()
  await expect(row(page, 'Channels')).not.toContainText('Needs setup')

  await page.goto(`${agentUrl}?tab=channels`)
  await expect(group(page, 'needs-setup').getByTestId('channel-row-whatsapp-channel')).toBeVisible()
  await expect(row(page, 'Channels')).toContainText('Needs setup')
})

test('the Channels row follows a change made on a channel page without leaving it', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.goto(`${agentUrl}?tab=channels&anchor=web-chat`)
  await expect(row(page, 'Channels')).toContainText('0 on')

  await page.locator('#anonChatToggle').click()
  await expect(row(page, 'Channels')).toContainText('1 on')
})

test('the agent area reads the agent list, the draft state and the channels once each', async ({ page }) => {
  const reads: Record<string, number> = { agents: 0, revisionState: 0, whatsapp: 0, general: 0 }
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  page.on('request', (request) => {
    if (request.method() !== 'GET') return
    const { pathname } = new URL(request.url())
    if (pathname === '/backend/api/v1/agents') reads.agents += 1
    if (pathname === `/backend/api/v1/agents/${defaultAgentId}/revision-state`) reads.revisionState += 1
    if (pathname === '/backend/api/v1/connectors/whatsapp') reads.whatsapp += 1
  })
  await page.goto(`${agentUrl}?tab=channels`)
  await expect(page.getByRole('heading', { name: 'Channels', level: 1, exact: true })).toBeVisible()
  await expect(row(page, 'Channels')).toContainText(/\d+ on/)
  await expect(group(page, 'not-set-up').getByTestId('channel-row-web-chat')).toBeVisible()

  expect(reads).toMatchObject({ agents: 1, revisionState: 1, whatsapp: 1 })
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

test('Rename… writes the name visitors see and the internal name, and the menu takes them at once', async ({ page }) => {
  const agentUpdates: unknown[] = []
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), agentUpdates })
  await page.goto(agentUrl)

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename agent' })
  await expect(dialog.getByLabel('Name visitors see')).toHaveValue('Marta')
  await expect(dialog.getByLabel('Internal name (optional)')).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
  await dialog.getByLabel('Name visitors see').fill('Marta Prime')
  await dialog.getByLabel('Internal name (optional)').fill('Marta (IT)')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(dialog).toBeHidden()
  await expect.poll(() => agentUpdates).toContainEqual({ name: 'Marta Prime', internalName: 'Marta (IT)' })
  // The menu shows the internal name, and the open Profile shows both, so its autosave cannot undo them.
  await expect(switcher(page, 'Marta (IT)')).toBeVisible()
  await expect(page.getByLabel('Assistant name')).toHaveValue('Marta Prime')
  await expect(page.locator('#agentInternalName')).toHaveValue('Marta (IT)')
})

test('creating an agent that fails says so once, and a new try starts clean', async ({ page }) => {
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings() })
  await page.route('**/backend/api/v1/agents', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await route.fulfill({ status: 500, json: { error: 'boom' } })
  })
  await page.goto(agentUrl)

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'New agent' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create agent' })
  await dialog.getByLabel('Name').fill('Acme Support')
  await dialog.getByRole('button', { name: 'Create manually' }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()

  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'New agent' }).click()
  await expect(page.getByRole('dialog', { name: 'Create agent' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Create agent' }).getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Create agent' }).getByLabel('Name')).toHaveValue('')
})

const historyLength = (page: Page) => page.evaluate(() => window.history.length)

test('Delete agent… from the menu moves once to the next agent, and the deleted agent is gone from the menu', async ({ page }) => {
  const deletes: string[] = []
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.route(`**/backend/api/v1/agents/${secondaryAgentId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deletes.push(route.request().url())
    await route.fulfill({ status: 204, body: '' })
  })
  await page.goto(`/w/${workspaceKey}/agents/${secondaryAgentId}?tab=chat`)
  await expect(switcher(page, 'sales')).toBeVisible()
  const entries = await historyLength(page)

  await switcher(page, 'sales').click()
  await page.getByRole('menuitem', { name: 'Delete agent…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete agent' })
  const confirm = dialog.getByRole('button', { name: 'Delete agent' })
  await expect(confirm).toBeDisabled()
  // The page behind the confirmation is the one the operator was on.
  await expect(page).toHaveURL(/tab=chat/)
  await dialog.getByLabel('Type sales to confirm').fill('sales')
  await confirm.click()

  await expect.poll(() => deletes).toHaveLength(1)
  await expect(page).toHaveURL(new RegExp(`/agents/${defaultAgentId}\\?tab=chat$`))
  await expect(switcher(page, 'Marta')).toBeVisible()
  // One replacement of the deleted agent's URL: no new history entry, so Back cannot land on it.
  expect(await historyLength(page)).toBe(entries)
  await switcher(page, 'Marta').click()
  await expect(page.getByRole('menuitem', { name: 'sales' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.goBack()
  await expect(page).not.toHaveURL(new RegExp(secondaryAgentId))
})

test('Delete agent… from a link that names no agent deletes the agent the menu shows', async ({ page }) => {
  const deletes: string[] = []
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deletes.push(route.request().url())
    await route.fulfill({ status: 204, body: '' })
  })
  // The URL names no agent, so the last agent used is the selection: the menu and the page must agree.
  await page.goto(`/w/${workspaceKey}/agents`)
  await switcher(page, 'Marta').click()
  await page.getByRole('menuitem', { name: 'Delete agent…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete agent' })
  await dialog.getByLabel('Type Marta to confirm').fill('Marta')
  await dialog.getByRole('button', { name: 'Delete agent' }).click()
  await expect.poll(() => deletes).toHaveLength(1)
  await expect(switcher(page, 'sales')).toBeVisible()
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

test('deleting from the old Danger zone link moves once, off the deleted agent', async ({ page }) => {
  const deletes: string[] = []
  await installDashboardApiMocks(page, { platformSettings: basePlatformSettings(), extraAgents: [secondaryAgent] })
  await page.route(`**/backend/api/v1/agents/${secondaryAgentId}`, async (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    deletes.push(route.request().url())
    await route.fulfill({ status: 204, body: '' })
  })
  await page.goto(`/w/${workspaceKey}/agents/${secondaryAgentId}?tab=behavior&anchor=agent-danger-zone`)
  const dialog = page.getByRole('dialog', { name: 'Delete agent' })
  await expect(dialog).toBeVisible()
  const entries = await historyLength(page)

  await dialog.getByLabel('Type sales to confirm').fill('sales')
  await dialog.getByRole('button', { name: 'Delete agent' }).click()

  await expect.poll(() => deletes).toHaveLength(1)
  await expect(page).toHaveURL(new RegExp(`/agents/${defaultAgentId}(\\?|$)`))
  await expect(page).not.toHaveURL(/agent-danger-zone/)
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  expect(await historyLength(page)).toBe(entries)
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
