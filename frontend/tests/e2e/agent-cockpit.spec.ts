import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'

import {
  basePlatformSettings,
  defaultAgentId,
  installDashboardApiMocks,
  nowIso,
  seedDashboardStorage,
  type RoutineFixture,
  workspaceKey,
} from './dashboard-fixtures'
import type { AgentRevisionState, TestExecution } from '@/lib/api-agent-revisions'

const testUrl = `/w/${workspaceKey}/agents/${defaultAgentId}?tab=chat`
const testChatComposerPlaceholder = 'Ask a question...'

const testChatComposer = (page: Page) => page.getByPlaceholder(testChatComposerPlaceholder)

const testChatMenuItem = (page: Page, label: string) =>
  page.locator('[role="menuitem"], [role="menuitemcheckbox"]').filter({ hasText: label })

const clickTestChatAction = async (page: Page, label: string) => {
  await page.getByRole('button', { name: 'Test chat actions', exact: true }).click()
  await testChatMenuItem(page, label).click()
}

const candidateId = '11111111-1111-4111-8111-111111111111'
const publishedId = '22222222-2222-4222-8222-222222222222'
const caseId = '33333333-3333-4333-8333-333333333333'

const candidate = { id: candidateId, label: 'Draft', kind: 'candidate' as const, versionNumber: null, createdAt: nowIso }
const published = { id: publishedId, label: 'v4', kind: 'published' as const, versionNumber: 4, createdAt: nowIso, publishedAt: nowIso }
const evalCandidate = { id: candidateId, versionNumber: null, label: 'Draft · 2026-09-09T00:00:00.000Z' }
const revisionState: AgentRevisionState = {
  agentId: defaultAgentId,
  status: 'draft_dirty' as const,
  draft: { generation: 8, basePublishedRevisionId: publishedId, updatedAt: nowIso },
  publishedRevision: published,
  canPublish: true,
  proactiveGreetingEnabled: false,
}

type CockpitMockOptions = {
  unavailable?: boolean
  delayMessage?: boolean
  delayStart?: boolean
  delayedStartFailure?: boolean
  prematureEof?: boolean
  keepEvalRunning?: boolean
  onlyForeignEvalCases?: boolean
  failMessage?: boolean
  requestBodies?: unknown[]
  messageBodies?: unknown[]
  messageExecutionIds?: string[]
  retainedSideIds?: string[]
  greetingBySide?: string[]
  assistantDefaultLocale?: string
  contextVariables?: Array<{ id: string; name: string; description: string | null; valueType: 'string' | 'json' }>
  enabledContextVariableIds?: string[]
  failFirstPublish?: boolean
  failEvalCase?: boolean
  qualityFailEvalCase?: boolean
  agentUpdates?: unknown[]
  executionHistory?: unknown[]
  executionDetail?: unknown
  delayExecutionDetail?: boolean
  replyBySide?: string[]
  revisionState?: typeof revisionState
  routines?: RoutineFixture[]
}

async function installCockpitMocks(page: Page, options: CockpitMockOptions = {}) {
  await seedDashboardStorage(page)
  const platformSettings = basePlatformSettings()
  if (options.assistantDefaultLocale) platformSettings.assistant.assistantDefaultLocale = options.assistantDefaultLocale
  await installDashboardApiMocks(page, { platformSettings, agentUpdates: options.agentUpdates, routines: options.routines })
  let executionNumber = 0
  let publicationAttempts = 0
  const sideCountByGeneration = new Map<number, number>()
  const executions = new Map<string, TestExecution>()
  let releaseMessage: (() => void) | undefined
  let messageReceived: (() => void) | undefined
  const messageRequest = new Promise<void>((resolve) => { messageReceived = resolve })
  let releaseStart: (() => void) | undefined
  let startReceived: (() => void) | undefined
  const startRequest = new Promise<void>((resolve) => { startReceived = resolve })
  let evalPollCount = 0
  let releaseExecutionDetail: (() => void) | undefined
  let executionDetailReceived: (() => void) | undefined
  const executionDetailRequest = new Promise<void>((resolve) => { executionDetailReceived = resolve })
  let secondEvalPollReceived: (() => void) | undefined
  const secondEvalPoll = new Promise<void>((resolve) => { secondEvalPollReceived = resolve })

  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revision-state`, async (route) => {
    if (options.unavailable) {
      await route.fulfill({ status: 503, json: { error: { message: 'Revision service unavailable' } } })
      return
    }
    await route.fulfill({ json: options.revisionState ?? revisionState })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/revisions\\?include=published$`), async (route) => {
    await route.fulfill({ json: { revisions: [published] } })
  })
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}/revisions/candidates`, async (route) => {
    options.requestBodies?.push(route.request().postDataJSON())
    await route.fulfill({ status: 201, json: { candidate } })
  })
  await page.route('**/backend/api/v1/evals/cases', async (route) => {
    const foreignCase = { id: '44444444-4444-4444-8444-444444444444', name: 'Other agent case', agent: { agentId: '55555555-5555-4555-8555-555555555555', name: 'Sales', internalName: 'sales', deleted: false } }
    const matchingCase = { id: caseId, name: 'Welcome answer is concise', agent: { agentId: defaultAgentId, name: 'Support', internalName: 'support', deleted: false } }
    await route.fulfill({ json: { cases: options.onlyForeignEvalCases ? [foreignCase] : [matchingCase], summary: {} } })
  })
  await page.route('**/backend/api/v1/context-variables', async (route) => {
    await route.fulfill({ json: { contextVariables: options.contextVariables ?? [] } })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/test-executions(?:\\?.*)?$`), async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { executions: options.executionHistory ?? [], nextCursor: null, hasMore: false } })
      return
    }
    startReceived?.()
    if (options.delayStart) await new Promise<void>((resolve) => { releaseStart = resolve })
    if (options.delayedStartFailure) {
      await route.fulfill({ status: 503, json: { error: { message: 'Obsolete start failed' } } })
      return
    }
    const body = route.request().postDataJSON() as { mode: 'single' | 'compare'; revisionIds: string[] }
    options.requestBodies?.push(body)
    executionNumber += 1
    const execution: TestExecution = {
      id: `execution-${executionNumber}`,
      generation: executionNumber,
      mode: body.mode,
      sides: body.revisionIds.map((revisionId, index) => ({
        id: `side-${executionNumber}-${index}`,
        revision: revisionId === candidateId ? candidate : published,
        conversationId: `conversation-${executionNumber}-${index}`,
        state: 'running',
        retryable: false,
        history: options.revisionState?.proactiveGreetingEnabled ? [{
            turnId: `greeting-turn-${executionNumber}-${index}`,
            role: 'assistant',
            content: options.greetingBySide?.[index] ?? 'Ciao, come posso aiutarti?',
            messageId: `greeting-${executionNumber}-${index}`,
            attemptId: `greeting-attempt-${executionNumber}-${index}`,
            createdAt: nowIso,
          }] : [],
      })),
    }
    executions.set(execution.id, execution)
    await route.fulfill({ status: 201, json: execution })
    sideCountByGeneration.set(executionNumber, body.revisionIds.length)
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/test-executions/[^/]+$`), async (route) => {
    executionDetailReceived?.()
    if (options.delayExecutionDetail) await new Promise<void>((resolve) => { releaseExecutionDetail = resolve })
    await route.fulfill({ json: { execution: options.executionDetail } })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/test-executions/[^/]+/messages$`), async (route) => {
    messageReceived?.()
    options.messageBodies?.push(route.request().postDataJSON())
    const executionMatch = route.request().url().match(/test-executions\/([^/]+)\/messages$/)
    if (executionMatch) options.messageExecutionIds?.push(executionMatch[1])
    if (options.delayMessage) await new Promise<void>((resolve) => { releaseMessage = resolve })
    const body = route.request().postDataJSON() as { executionGeneration: number; turnId: string; attemptId: string }
    const sideId = `side-${body.executionGeneration}-0`
    const event = options.failMessage
      ? { type: 'side_failed', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId, code: 'provider_unavailable', retryable: true, turnId: body.turnId, attemptId: body.attemptId }
      : { type: 'message_delta', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId, delta: 'A fenced answer.', turnId: body.turnId, attemptId: body.attemptId }
    const active = executions.get(`execution-${body.executionGeneration}`)
    const responseEvents = options.failMessage
      ? `data: ${JSON.stringify(event)}\n\n`
      : options.prematureEof
        ? (() => {
          const delta = { type: 'message_delta', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId, delta: 'A fenced answer.', turnId: body.turnId, attemptId: body.attemptId }
          const done = { type: 'side_completed', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId, messageId: 'message-0', turnId: body.turnId, attemptId: body.attemptId }
          return `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(done)}\n\n`
        })()
      : Array.from({ length: sideCountByGeneration.get(body.executionGeneration) ?? 1 }, (_, index) => {
        const currentSideId = `side-${body.executionGeneration}-${index}`
        const answer = options.replyBySide?.[index] ?? (index === 0 ? 'A fenced answer.' : 'A comparison answer.')
        const activeSide = active?.sides.find((side) => side.id === currentSideId)
        if (activeSide) {
          activeSide.history = [...(activeSide.history ?? []),
            { turnId: body.turnId, role: 'user', content: route.request().postDataJSON().message, attemptId: body.attemptId, createdAt: nowIso },
            { turnId: body.turnId, role: 'assistant', content: answer, messageId: `message-${index}`, attemptId: body.attemptId, createdAt: nowIso },
          ]
          activeSide.state = 'completed'
        }
        const delta = { type: 'message_delta', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId: currentSideId, delta: answer, turnId: body.turnId, attemptId: body.attemptId }
        const done = { type: 'side_completed', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId: currentSideId, messageId: `message-${index}`, turnId: body.turnId, attemptId: body.attemptId }
        return `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(done)}\n\n`
      }).join('')
    await route.fulfill({ contentType: 'text/event-stream', body: responseEvents })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/test-executions/[^/]+/sides/[^/]+/retain$`), async (route) => {
    const match = route.request().url().match(/test-executions\/([^/]+)\/sides\/([^/]+)\/retain$/)
    const source = match ? executions.get(match[1]) : undefined
    const side = source?.sides.find((candidate) => candidate.id === match?.[2])
    if (!source || !side) {
      await route.fulfill({ status: 404, json: { error: { message: 'Test execution side is unavailable' } } })
      return
    }
    options.retainedSideIds?.push(side.id)
    executionNumber += 1
    const retained: TestExecution = {
      id: `execution-${executionNumber}`,
      generation: executionNumber,
      mode: 'single',
      sides: [{ ...side, id: `side-${executionNumber}-0`, conversationId: `conversation-${executionNumber}-0`, history: [...(side.history ?? [])] }],
    }
    executions.set(retained.id, retained)
    sideCountByGeneration.set(retained.generation, 1)
    await route.fulfill({ status: 201, json: retained })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/test-executions/[^/]+/sides/[^/]+/retry$`), async (route) => {
    const body = route.request().postDataJSON() as { executionGeneration: number; turnId: string; attemptId: string }
    options.requestBodies?.push(body)
    const sideId = `side-${body.executionGeneration}-0`
    await route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ type: 'message_delta', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId, delta: 'Recovered retry answer.', turnId: body.turnId, attemptId: body.attemptId })}\n\ndata: ${JSON.stringify({ type: 'side_completed', executionId: `execution-${body.executionGeneration}`, generation: body.executionGeneration, sideId, messageId: 'retry-message', turnId: body.turnId, attemptId: body.attemptId })}\n\n` })
  })
  await page.route('**/backend/api/v1/evals/revision-runs', async (route) => {
    options.requestBodies?.push(route.request().postDataJSON())
    await route.fulfill({ status: 201, json: { id: 'eval-run-1', state: 'running', sides: [{ revisionId: candidateId, revision: evalCandidate, state: 'running', evidenceState: 'comparability_unknown', cases: [{ caseId, state: 'running', outcome: 'partial' }] }] } })
  })
  await page.route('**/backend/api/v1/evals/revision-runs/eval-run-1', async (route) => {
    evalPollCount += 1
    if (evalPollCount >= 2) secondEvalPollReceived?.()
    await route.fulfill({ json: options.keepEvalRunning && evalPollCount === 1
      ? { id: 'eval-run-1', state: 'running', sides: [{ revisionId: candidateId, revision: evalCandidate, state: 'running', evidenceState: 'comparability_unknown', cases: [{ caseId, state: 'running', outcome: 'partial' }] }] }
      : { id: 'eval-run-1', state: 'completed', sides: [{ revisionId: candidateId, revision: evalCandidate, state: options.failEvalCase ? 'failed' : 'completed', evidenceState: 'current', cases: [{ caseId, state: options.failEvalCase ? 'failed' : 'completed', outcome: options.failEvalCase || options.qualityFailEvalCase ? 'fail' : 'pass' }] }] } })
  })
  await page.route(`**/backend/api/v1/evals/revision-runs/eval-run-1/sides/${candidateId}/cases/${caseId}/retry`, async (route) => {
    await route.fulfill({ json: { id: 'eval-run-1', state: 'completed', sides: [{ revisionId: candidateId, revision: evalCandidate, state: 'completed', evidenceState: 'current', cases: [{ caseId, state: 'completed', outcome: 'pass' }] }] } })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/revisions/${candidateId}$`), async (route) => {
    await route.fulfill({ json: { revision: {
      ...candidate,
      snapshotFormatVersion: 1,
      enabledContextVariableIds: options.enabledContextVariableIds ?? [],
      scope: { customInstructions: true, directives: true, routines: true, contextVariableEnablements: true },
      dependencyWarnings: [{ code: 'routine_reference', message: 'One routine is pinned.' }],
      scopedChanges: { customInstruction: { before: 'Old', after: 'New', changed: true }, directives: [{ id: 'directive-1', change: 'changed', before: { name: 'Welcome directive', content: 'Old direction' }, after: { name: 'Welcome directive', content: 'New direction' } }], routines: [{ definitionId: 'routine-1', change: 'changed', before: { name: 'Order lookup', steps: ['old'] }, after: { name: 'Order lookup', steps: ['new'] } }], contextVariableEnablements: [{ contextVariableId: 'tier', change: 'added' }] },
    } } })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/revisions/${publishedId}$`), async (route) => {
    await route.fulfill({ json: { revision: {
      ...published,
      snapshotFormatVersion: 1,
      enabledContextVariableIds: [],
      scope: { customInstructions: true, directives: true, routines: true, contextVariableEnablements: true },
      dependencyWarnings: [],
      scopedChanges: { customInstruction: { before: 'Old', after: 'Old', changed: false }, directives: [], routines: [], contextVariableEnablements: [] },
    } } })
  })
  await page.route(new RegExp(`/backend/api/v1/agents/${defaultAgentId}/revisions/${candidateId}/publish$`), async (route) => {
    options.requestBodies?.push(route.request().postDataJSON())
    publicationAttempts += 1
    if (options.failFirstPublish && publicationAttempts === 1) {
      await route.fulfill({ status: 503, json: { error: { message: 'Publication timed out' } } })
      return
    }
    await route.fulfill({ json: { publication: { id: 'publication-1', revisionId: candidateId, publishedAt: nowIso, idempotentReplay: false }, state: { ...revisionState, status: 'draft_clean', publishedRevision: candidate } } })
  })

  return { messageRequest, releaseMessage: () => releaseMessage?.(), startRequest, releaseStart: () => releaseStart?.(), secondEvalPoll, executionDetailRequest, releaseExecutionDetail: () => releaseExecutionDetail?.() }
}

test('uses an explicit eval selection and sends the exact candidate and cases', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies })
  await page.goto(testUrl)

  await clickTestChatAction(page, 'Evals')
  const evalDialog = page.getByRole('dialog')
  const runEvals = evalDialog.getByRole('button', { name: 'Run evals' })
  await expect(runEvals).toBeDisabled()
  await page.getByLabel('Welcome answer is concise').check()
  await expect(runEvals).toBeEnabled()
  await runEvals.click()

  await expect(page.getByRole('columnheader', { name: evalCandidate.label, exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Passed Completed · Current' })).toBeVisible()
  expect(requestBodies).toContainEqual({ revisionIds: [candidateId], caseIds: [caseId], testValues: [], mode: 'full_assistant', executionPolicy: 'safe_test' })
})

test('does not offer workspace eval cases captured from another agent', async ({ page }) => {
  await installCockpitMocks(page, { onlyForeignEvalCases: true })
  await page.goto(testUrl)

  await clickTestChatAction(page, 'Evals')
  await expect(page.getByText('Other agent case')).toHaveCount(0)
  await expect(page.getByText('No eval cases belong to this agent.')).toBeVisible()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Run evals' })).toBeDisabled()
})

test('retries a failed revision eval case without replacing its sibling evidence', async ({ page }) => {
  await installCockpitMocks(page, { failEvalCase: true })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'Evals')
  await page.getByLabel('Welcome answer is concise').check()
  await page.getByRole('dialog').getByRole('button', { name: 'Run evals' }).click()
  await page.getByRole('button', { name: 'Retry case' }).click()
  await expect(page.getByRole('cell', { name: 'Passed Completed · Current' })).toBeVisible()
})

test('accepts a revision eval retry after returning to cached evidence', async ({ page }) => {
  await installCockpitMocks(page, { failEvalCase: true })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'Evals')
  await page.getByLabel('Welcome answer is concise').check()
  await page.getByRole('dialog').getByRole('button', { name: 'Run evals' }).click()
  await expect(page.getByRole('button', { name: 'Retry case' })).toBeVisible()
  await page.keyboard.press('Escape')

  const cockpit = page.getByRole('navigation', { name: 'Agent cockpit' })
  await cockpit.getByRole('tab', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await cockpit.getByRole('tab', { name: 'Test Chat', exact: true }).click()
  await clickTestChatAction(page, 'Evals')
  await page.getByRole('button', { name: 'Retry case' }).click()

  await expect(page.getByRole('cell', { name: 'Passed Completed · Current' })).toBeVisible()
})

test('keeps completed quality failures as evidence without offering retry', async ({ page }) => {
  await installCockpitMocks(page, { qualityFailEvalCase: true })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'Evals')
  await page.getByLabel('Welcome answer is concise').check()
  await page.getByRole('dialog').getByRole('button', { name: 'Run evals' }).click()
  await expect(page.getByRole('cell', { name: 'Failed Completed · Current' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry case' })).toHaveCount(0)
})

test('uses named typed values from the immutable selected revision', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, {
    requestBodies,
    enabledContextVariableIds: ['tier', 'cart'],
    contextVariables: [
      { id: 'tier', name: 'Customer tier', description: 'Current account tier', valueType: 'string' },
      { id: 'cart', name: 'Cart', description: 'Active basket', valueType: 'json' },
    ],
  })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'Test context')
  const contextDialog = page.getByRole('dialog')
  await expect(contextDialog.getByLabel('Customer tier')).toBeVisible()
  await expect(contextDialog.getByLabel('Cart')).toBeVisible()
  await contextDialog.getByLabel('Customer tier').fill('enterprise')
  await contextDialog.getByLabel('Cart').fill('{"items":2}')
  await page.keyboard.press('Escape')
  await testChatComposer(page).fill('Typed values')
  await page.getByRole('button', { name: 'Send' }).click()
  expect(requestBodies).toContainEqual(expect.objectContaining({ testValues: [
    { contextVariableId: 'tier', value: 'enterprise' },
    { contextVariableId: 'cart', value: { items: 2 } },
  ] }))
})

test('keeps the clean chat actions focused and restores normal composer behavior', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies })
  await page.goto(testUrl)

  await page.getByRole('button', { name: 'Test chat actions', exact: true }).click()
  for (const label of ['New chat', 'History', 'Compare versions', 'Evals']) {
    await expect(testChatMenuItem(page, label)).toHaveCount(1)
  }
  await expect(testChatMenuItem(page, 'Test context')).toHaveCount(0)
  await page.keyboard.press('Escape')

  const composer = testChatComposer(page)
  await composer.fill('A normal test question\nA second line')
  await expect(composer).toHaveValue('A normal test question\nA second line')
  await composer.press('Enter')
  await expect.poll(() => requestBodies).toContainEqual(expect.objectContaining({
    mode: 'single',
    revisionIds: [candidateId],
  }))
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Copy message', exact: true })).toBeVisible()
})

test('keeps the end of a long answer in view while following the conversation', async ({ page }) => {
  const answer = [...Array.from({ length: 24 }, (_, index) => `Shipping detail ${index + 1}: allow two working days for this step.`), 'Your order is ready for dispatch.'].join('\n\n')
  await installCockpitMocks(page, { replyBySide: [answer] })
  await page.goto(testUrl)
  await testChatComposer(page).fill('Explain the shipping steps')
  await testChatComposer(page).press('Enter')
  await expect(page.getByText('Your order is ready for dispatch.', { exact: true })).toBeInViewport()
  await expect(testChatComposer(page)).toBeInViewport()
  await page.locator('.radioso-themed-scrollbar').first().hover()
  await page.waitForTimeout(350)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-single-overflow-desktop.png'), fullPage: false })
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-long-thread-scrollbar.png') })
})

test('switches from one private test to an aligned two-version comparison', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies })
  await page.goto(testUrl)

  await testChatComposer(page).fill('Hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect.poll(() => requestBodies).toContainEqual(expect.objectContaining({ mode: 'single', revisionIds: [candidateId] }))

  await clickTestChatAction(page, 'Compare versions')
  await expect(page.getByRole('status').filter({ hasText: 'Test mode changed' })).toContainText('Test mode changed')
  await expect(page.getByLabel('Revision 1')).toBeVisible()
  await expect(page.getByLabel('Revision 2')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send to both' })).toBeVisible()
  await testChatComposer(page).fill('Compare this')
  await page.getByRole('button', { name: 'Send to both' }).click()
  expect(requestBodies).toContainEqual(expect.objectContaining({ mode: 'compare', revisionIds: [publishedId, candidateId] }))
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('A comparison answer.', { exact: true })).toBeVisible()
  await testChatComposer(page).fill('And this follow-up')
  await page.getByRole('button', { name: 'Send to both' }).click()
  await expect(page.getByText('And this follow-up', { exact: true })).toHaveCount(2)
})

test('closes the draft comparison card into its retained published thread', async ({ page }) => {
  const retainedSideIds: string[] = []
  const messageExecutionIds: string[] = []
  await installCockpitMocks(page, { retainedSideIds, messageExecutionIds })
  await page.goto(testUrl)

  await page.getByRole('button', { name: 'Compare versions', exact: true }).click()
  await testChatComposer(page).fill('Compare this')
  await page.getByRole('button', { name: 'Send to both', exact: true }).click()
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('A comparison answer.', { exact: true })).toBeVisible()
  await testChatComposer(page).fill('Keep this unpublished follow-up')
  await page.getByRole('button', { name: 'Close Draft', exact: true }).click()

  expect(retainedSideIds).toEqual(['side-1-0'])
  await expect(page.getByRole('combobox', { name: 'Revision 1', exact: true })).toHaveCount(1)
  await expect(page.getByRole('combobox', { name: 'Revision 2', exact: true })).toHaveCount(0)
  await expect(page.getByText('Compare this', { exact: true })).toHaveCount(1)
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('A comparison answer.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Ciao, come posso aiutarti?', { exact: true })).toHaveCount(0)
  await expect(testChatComposer(page)).toHaveValue('Keep this unpublished follow-up')

  await page.getByRole('button', { name: 'Test chat actions', exact: true }).click()
  await expect(testChatMenuItem(page, 'Single chat')).toHaveCount(0)
  await expect(testChatMenuItem(page, 'Compare versions')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => messageExecutionIds).toEqual(['execution-1', 'execution-2'])
  await expect(page.getByText('Keep this unpublished follow-up', { exact: true })).toHaveCount(1)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-retained-published.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Compare versions', exact: true })).toBeInViewport()
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-retained-published-mobile.png'), fullPage: true })
})

test('closes the published comparison card into its retained draft thread', async ({ page }) => {
  const retainedSideIds: string[] = []
  const messageExecutionIds: string[] = []
  await installCockpitMocks(page, { retainedSideIds, messageExecutionIds })
  await page.goto(testUrl)

  await page.getByRole('button', { name: 'Compare versions', exact: true }).click()
  await testChatComposer(page).fill('Compare this')
  await page.getByRole('button', { name: 'Send to both', exact: true }).click()
  await expect(page.getByText('A comparison answer.', { exact: true })).toBeVisible()
  await testChatComposer(page).fill('Continue only the draft')
  await page.getByRole('button', { name: 'Close v4', exact: true }).click()

  expect(retainedSideIds).toEqual(['side-1-1'])
  await expect(page.getByText('A comparison answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('A fenced answer.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Compare this', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Ciao, come posso aiutarti?', { exact: true })).toHaveCount(0)
  await expect(testChatComposer(page)).toHaveValue('Continue only the draft')

  await page.getByRole('button', { name: 'Test chat actions', exact: true }).click()
  await expect(testChatMenuItem(page, 'Single chat')).toHaveCount(0)
  await expect(testChatMenuItem(page, 'Compare versions')).toHaveCount(1)
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => messageExecutionIds).toEqual(['execution-1', 'execution-2'])
  await expect(page.getByText('Continue only the draft', { exact: true })).toHaveCount(1)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-retained-draft.png'), fullPage: true })
})

test('keeps comparison close controls disabled while their response stream is active', async ({ page }) => {
  const mocks = await installCockpitMocks(page, { delayMessage: true })
  await page.goto(testUrl)

  await page.getByRole('button', { name: 'Compare versions', exact: true }).click()
  await testChatComposer(page).fill('Wait before closing')
  await page.getByRole('button', { name: 'Send to both', exact: true }).click()
  await mocks.messageRequest
  const closeDraft = page.getByRole('button', { name: 'Close Draft', exact: true })
  await expect(closeDraft).toBeDisabled()
  await expect(closeDraft).toHaveAttribute('title', 'Wait for the current response before closing this version.')
  mocks.releaseMessage()
  await expect(closeDraft).toBeEnabled()
})

test('reopens a durable comparison with its recorded versions, values, and transcript', async ({ page }) => {
  const saved = {
    id: 'execution-history-1', generation: 4, mode: 'compare', state: 'completed', createdAt: nowIso,
    sides: [
      { id: 'history-left', revision: published, conversationId: 'conversation-left', state: 'completed', retryable: false },
      { id: 'history-right', revision: candidate, conversationId: 'conversation-right', state: 'completed', retryable: false },
    ],
  }
  await installCockpitMocks(page, {
    revisionState: { ...revisionState, proactiveGreetingEnabled: true },
    greetingBySide: ['Ciao, bentornato!', 'Ciao, bentornato!'],
    executionHistory: [saved],
    executionDetail: {
      ...saved,
      testValues: [{ contextVariableId: 'tier', value: 'enterprise' }],
      sides: saved.sides.map((side) => ({
        ...side,
        history: [
          { turnId: 'greeting-turn', role: 'assistant', content: 'Ciao, bentornato!', attemptId: 'greeting-attempt', createdAt: nowIso },
          { turnId: 'turn-history', role: 'user', content: 'Track my order', attemptId: 'attempt-history', createdAt: nowIso },
          { turnId: 'turn-history', role: 'assistant', content: side.id === 'history-left' ? 'Published answer' : 'Draft answer', attemptId: 'attempt-history', createdAt: nowIso },
        ],
      })),
      attempts: saved.sides.map((side) => ({ sideId: side.id, turnId: 'turn-history', attemptId: 'attempt-history', fence: 3, state: 'completed', createdAt: nowIso, updatedAt: nowIso })),
    },
  })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'History')
  await expect(page.getByText('Comparison', { exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: /v4.*Draft/ })).toBeVisible()
  await page.getByRole('button', { name: 'Open' }).click()

  await expect(page.getByText('Track my order', { exact: true })).toHaveCount(2)
  await expect(page.getByText('Ciao, bentornato!', { exact: true })).toHaveCount(2)
  await expect(page.getByText('Published answer', { exact: true })).toBeVisible()
  await expect(page.getByText('Draft answer', { exact: true })).toBeVisible()
})

test('fences a delayed history open after the operator returns to a new chat', async ({ page }) => {
  const saved = {
    id: 'execution-history-slow', generation: 1, mode: 'single', state: 'completed', createdAt: nowIso,
    sides: [{ id: 'slow-side', revision: candidate, conversationId: 'slow-conversation', state: 'completed', retryable: false }],
  }
  const mocks = await installCockpitMocks(page, {
    delayExecutionDetail: true,
    executionHistory: [saved],
    executionDetail: {
      ...saved,
      testValues: [],
      sides: [{ ...saved.sides[0], history: [{ turnId: 'slow-turn', role: 'user', content: 'Old delayed request', attemptId: 'slow-attempt', createdAt: nowIso }] }],
      attempts: [{ sideId: 'slow-side', turnId: 'slow-turn', attemptId: 'slow-attempt', fence: 1, state: 'completed', createdAt: nowIso, updatedAt: nowIso, leaseExpiresAt: nowIso }],
    },
  })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'History')
  await page.getByRole('button', { name: 'Open' }).click()
  await mocks.executionDetailRequest
  await page.getByRole('button', { name: 'Back to chat', exact: true }).click()
  await clickTestChatAction(page, 'New chat')
  mocks.releaseExecutionDetail()

  await expect(page.getByText('Old delayed request', { exact: true })).toHaveCount(0)
})

test('new chat keeps a running eval poll and its evidence while clearing only the visible test', async ({ page }) => {
  const mocks = await installCockpitMocks(page, { keepEvalRunning: true })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'Evals')
  await page.getByLabel('Welcome answer is concise').check()
  await page.getByRole('dialog').getByRole('button', { name: 'Run evals' }).click()
  await page.keyboard.press('Escape')
  await testChatComposer(page).fill('Hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await clickTestChatAction(page, 'New chat')
  await expect(page.getByRole('status').filter({ hasText: 'New chat ready' })).toContainText('New chat ready')
  await mocks.secondEvalPoll
  await clickTestChatAction(page, 'Evals')
  await expect(page.getByRole('cell', { name: 'Passed Completed · Current' })).toBeVisible()
})

test('reopens a later failed turn and retries that recorded turn only', async ({ page }) => {
  const requestBodies: unknown[] = []
  const saved = {
    id: 'execution-history-failed', generation: 4, mode: 'compare', state: 'partial', createdAt: nowIso,
    sides: [
      { id: 'failed-left', revision: published, conversationId: 'conversation-left', state: 'completed', retryable: false },
      { id: 'failed-right', revision: candidate, conversationId: 'conversation-right', state: 'failed', retryable: true },
    ],
  }
  await installCockpitMocks(page, {
    requestBodies,
    executionHistory: [saved],
    executionDetail: {
      ...saved,
      testValues: [],
      sides: saved.sides.map((side) => ({
        ...side,
        history: [
          { turnId: 'earlier-turn', role: 'user', content: 'First', attemptId: 'earlier-attempt', createdAt: nowIso },
          { turnId: 'earlier-turn', role: 'assistant', content: 'First answer', attemptId: 'earlier-attempt', createdAt: nowIso },
          { turnId: 'later-turn', role: 'user', content: 'Second', attemptId: 'later-attempt', createdAt: nowIso },
        ],
      })),
      attempts: [
        { sideId: 'failed-left', turnId: 'later-turn', attemptId: 'later-attempt', fence: 2, state: 'completed', createdAt: nowIso, updatedAt: nowIso, leaseExpiresAt: nowIso },
        { sideId: 'failed-right', turnId: 'later-turn', attemptId: 'later-attempt', fence: 2, state: 'failed', failureCode: 'provider_unavailable', createdAt: nowIso, updatedAt: nowIso, leaseExpiresAt: nowIso },
      ],
    },
  })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'History')
  await page.getByRole('button', { name: 'Open' }).click()
  await page.getByRole('button', { name: 'Retry this side' }).click()

  expect(requestBodies).toContainEqual(expect.objectContaining({ executionGeneration: 4, turnId: 'later-turn', attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/) }))
})

test('fences a delayed stream after test values reset the execution', async ({ page }) => {
  const mocks = await installCockpitMocks(page, { delayMessage: true, enabledContextVariableIds: ['tier'], contextVariables: [{ id: 'tier', name: 'Customer tier', description: null, valueType: 'string' }] })
  await page.goto(testUrl)
  await testChatComposer(page).fill('Hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await mocks.messageRequest

  await clickTestChatAction(page, 'Test context')
  await page.getByRole('dialog').getByLabel('Customer tier').fill('enterprise')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('status').filter({ hasText: 'Test values changed' })).toContainText('Test values changed')
  await expect(testChatComposer(page)).toBeEnabled()
  mocks.releaseMessage()
  await expect(page.getByText('A fenced answer.', { exact: true })).toHaveCount(0)
})

test('ignores an obsolete delayed start failure after the operator changes revision mode', async ({ page }) => {
  const mocks = await installCockpitMocks(page, { delayStart: true, delayedStartFailure: true })
  await page.goto(testUrl)

  await testChatComposer(page).fill('Hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await mocks.startRequest
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled()
  await clickTestChatAction(page, 'Compare versions')
  await expect(page.getByRole('status').filter({ hasText: 'Test mode changed' })).toContainText('Test mode changed')
  mocks.releaseStart()
  await expect(page.getByText('Obsolete start failed')).toHaveCount(0)
  await expect(testChatComposer(page)).toBeEnabled()
})

test('marks only an unfinished comparison side retryable after clean premature EOF', async ({ page }) => {
  await installCockpitMocks(page, { prematureEof: true })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'Compare versions')
  await testChatComposer(page).fill('Compare this')
  await page.getByRole('button', { name: 'Send to both' }).click()

  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('The response ended before completion.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry this side' })).toHaveCount(1)
})

test('keeps a delayed chat stream alive while revision eval polling continues', async ({ page }) => {
  const mocks = await installCockpitMocks(page, { delayMessage: true, keepEvalRunning: true })
  await page.goto(testUrl)
  await clickTestChatAction(page, 'Evals')
  await page.getByLabel('Welcome answer is concise').check()
  await page.getByRole('dialog').getByRole('button', { name: 'Run evals' }).click()
  await page.keyboard.press('Escape')
  await testChatComposer(page).fill('Hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await mocks.messageRequest
  await mocks.secondEvalPoll
  mocks.releaseMessage()
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
})

test('invalidates the selected saved-draft test after a draft-save event', async ({ page }) => {
  const mocks = await installCockpitMocks(page, { delayMessage: true })
  await page.goto(testUrl)
  await testChatComposer(page).fill('Hello')
  await page.getByRole('button', { name: 'Send' }).click()
  await mocks.messageRequest

  await page.evaluate((agentId) => window.dispatchEvent(new CustomEvent('radioso:agent-draft-saved', { detail: { agentId } })), defaultAgentId)
  await expect(page.getByRole('status').filter({ hasText: 'Saved draft selected' })).toContainText('Saved draft selected')
  mocks.releaseMessage()
  await expect(page.getByText('A fenced answer.', { exact: true })).toHaveCount(0)
  await expect(testChatComposer(page)).toBeEnabled()
})

test('fails closed when revision state is unavailable', async ({ page }) => {
  await installCockpitMocks(page, { unavailable: true })
  await page.goto(testUrl)

  await expect(page.getByText('Private revision testing is unavailable. No live chat is started.')).toBeVisible()
  await expect(testChatComposer(page)).toHaveCount(0)
})

test('renders a failed side and retries only that side', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { failMessage: true, requestBodies })
  await page.goto(testUrl)
  await testChatComposer(page).fill('Hello')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText('The provider was unavailable.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Retry this side' }).click()
  expect(requestBodies).toContainEqual(expect.objectContaining({ executionGeneration: 1, turnId: expect.stringMatching(/^[0-9a-f-]{36}$/), attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/) }))
  await expect(page.getByText('Recovered retry answer.', { exact: true })).toBeVisible()
})

test('saves the mounted dirty editor before lazily starting a private test', async ({ page }) => {
  const requestBodies: unknown[] = []
  const draftWrites: unknown[] = []
  await installCockpitMocks(page, { requestBodies })
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}`, async (route) => {
    if (route.request().method() === 'PUT') draftWrites.push(route.request().postDataJSON())
    await route.fallback()
  })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`)
  await page.locator('#assistantAnswerInstruction').fill('Save this private instruction before testing.')
  await page.getByRole('tab', { name: 'Test Chat' }).click()
  await testChatComposer(page).fill('Does the saved draft answer?')
  await expect(page.getByRole('button', { name: 'Save draft & send' })).toBeEnabled()
  await page.getByRole('button', { name: 'Save draft & send' }).click()

  await expect.poll(() => draftWrites).toEqual(expect.arrayContaining([expect.objectContaining({ customInstruction: 'Save this private instruction before testing.' })]))
  await expect.poll(() => requestBodies).toContainEqual(expect.objectContaining({ mode: 'single', revisionIds: [candidateId] }))
})

test('does not start a private execution when the mounted draft save fails', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies })
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}`, async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 503, json: { error: { message: 'Draft save unavailable' } } })
      return
    }
    await route.fallback()
  })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`)
  await page.locator('#assistantAnswerInstruction').fill('This save fails.')
  await page.getByRole('tab', { name: 'Test Chat' }).click()
  await testChatComposer(page).fill('Keep this message')
  await page.getByRole('button', { name: 'Save draft & send' }).click()

  await expect(page.getByRole('alert').filter({ hasText: 'Draft save unavailable' })).toContainText('Draft save unavailable')
  await expect(testChatComposer(page)).toHaveValue('Keep this message')
  expect(requestBodies).not.toContainEqual(expect.objectContaining({ mode: 'single', revisionIds: [candidateId] }))
})

test('fences a delayed draft save after New chat before it can create an execution', async ({ page }) => {
  const requestBodies: unknown[] = []
  let releaseDraftSave: (() => void) | undefined
  let draftSaveReceived: (() => void) | undefined
  const draftSaveRequest = new Promise<void>((resolve) => { draftSaveReceived = resolve })
  await installCockpitMocks(page, { requestBodies })
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}`, async (route) => {
    if (route.request().method() === 'PUT') {
      draftSaveReceived?.()
      await new Promise<void>((resolve) => { releaseDraftSave = resolve })
    }
    await route.fallback()
  })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`)
  await page.locator('#assistantAnswerInstruction').fill('Save slowly.')
  await page.getByRole('tab', { name: 'Test Chat' }).click()
  await testChatComposer(page).fill('Do not send this')
  await page.getByRole('button', { name: 'Save draft & send' }).click()
  await draftSaveRequest
  await clickTestChatAction(page, 'New chat')
  releaseDraftSave?.()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await expect(testChatComposer(page)).toHaveValue('Do not send this')
  expect(requestBodies).not.toContainEqual(expect.objectContaining({ mode: 'single', revisionIds: [candidateId] }))
})

test('reviews full scoped changes and publishes the selected candidate with a frozen idempotency key', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies, contextVariables: [{ id: 'tier', name: 'Customer tier', description: null, valueType: 'string' }] })
  await page.goto(testUrl)
  await page.getByRole('button', { name: 'Review & publish', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('Before')
  await expect(page.getByRole('dialog')).toContainText('Welcome directive (changed)')
  await expect(page.getByRole('dialog')).toContainText('Order lookup (changed)')
  await expect(page.getByRole('dialog')).toContainText('Customer tier (added)')
  await expect(page.getByRole('dialog')).toContainText('After')
  await page.getByRole('button', { name: 'Publish revision' }).click()

  expect(requestBodies).toContainEqual(expect.objectContaining({
    expectedDraftGeneration: 8,
    expectedPublishedRevisionId: publishedId,
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
  }))
})

test('keeps Review & publish available for a permitted clean saved draft', async ({ page }) => {
  await installCockpitMocks(page, {
    revisionState: { ...revisionState, status: 'draft_clean' },
  })
  await page.goto(testUrl)

  await expect(page.getByRole('button', { name: 'Review & publish', exact: true })).toBeVisible()
})

test('shows the enabled Italian fallback greeting before the first message', async ({ page }) => {
  const requestBodies: unknown[] = []
  const messageBodies: unknown[] = []
  await installCockpitMocks(page, {
    requestBodies,
    messageBodies,
    assistantDefaultLocale: 'it',
    revisionState: { ...revisionState, proactiveGreetingEnabled: true },
    greetingBySide: ['Ciao, come posso aiutarti?'],
  })

  await page.goto(testUrl)
  await expect(page.getByText('Ciao, come posso aiutarti?', { exact: true })).toBeVisible()
  expect(messageBodies).toHaveLength(0)
  await expect.poll(() => requestBodies.filter((body) =>
    body !== null && typeof body === 'object' && 'mode' in body,
  )).toHaveLength(1)
})

test('keeps a disabled proactive greeting lazy until the first message', async ({ page }) => {
  const requestBodies: unknown[] = []
  const messageBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies, messageBodies })

  await page.goto(testUrl)
  await expect(testChatComposer(page)).toBeVisible()
  expect(requestBodies.filter((body) => body !== null && typeof body === 'object' && 'mode' in body)).toHaveLength(0)
  expect(messageBodies).toHaveLength(0)

  await testChatComposer(page).fill('First message')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => requestBodies.filter((body) => body !== null && typeof body === 'object' && 'mode' in body)).toHaveLength(1)
  await expect.poll(() => messageBodies).toHaveLength(1)
})

test('starts one pinned greeting per comparison pane before sending', async ({ page }) => {
  const requestBodies: unknown[] = []
  const messageBodies: unknown[] = []
  await installCockpitMocks(page, {
    requestBodies,
    messageBodies,
    revisionState: { ...revisionState, proactiveGreetingEnabled: true },
    greetingBySide: ['Ciao dalla versione pubblicata.', 'Ciao dalla bozza.'],
  })

  await page.goto(testUrl)
  await expect(page.getByText('Ciao dalla versione pubblicata.', { exact: true })).toBeVisible()
  await clickTestChatAction(page, 'Compare versions')
  await expect(page.getByText('Ciao dalla versione pubblicata.', { exact: true })).toBeVisible()
  await expect(page.getByText('Ciao dalla bozza.', { exact: true })).toBeVisible()
  expect(messageBodies).toHaveLength(0)
  await expect.poll(() => requestBodies.filter((body) => body !== null && typeof body === 'object' && 'mode' in body)).toHaveLength(2)
  expect(requestBodies).toContainEqual(expect.objectContaining({ mode: 'compare', revisionIds: [publishedId, candidateId] }))
})

test('starts one fresh greeting after New chat without duplicating it', async ({ page }) => {
  const requestBodies: unknown[] = []
  const messageBodies: unknown[] = []
  await installCockpitMocks(page, {
    requestBodies,
    messageBodies,
    revisionState: { ...revisionState, proactiveGreetingEnabled: true },
    greetingBySide: ['Ciao, bentornato!'],
  })

  await page.goto(testUrl)
  await expect(page.getByText('Ciao, bentornato!', { exact: true })).toBeVisible()
  await expect.poll(() => requestBodies.filter((body) => body !== null && typeof body === 'object' && 'mode' in body)).toHaveLength(1)
  await clickTestChatAction(page, 'New chat')
  await expect.poll(() => requestBodies.filter((body) => body !== null && typeof body === 'object' && 'mode' in body)).toHaveLength(2)
  await expect(page.getByText('Ciao, bentornato!', { exact: true })).toHaveCount(1)
  expect(messageBodies).toHaveLength(0)
})

test('retries a timed-out publication with the same frozen command', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies, failFirstPublish: true })
  await page.goto(testUrl)
  await page.getByRole('button', { name: 'Review & publish', exact: true }).click()
  await page.getByRole('button', { name: 'Publish revision' }).click()
  await expect(page.getByRole('alert')).toContainText('Publication timed out')
  await page.getByRole('button', { name: 'Publish revision' }).click()
  const publishBodies = requestBodies.filter((body): body is { idempotencyKey: string } => body !== null && typeof body === 'object' && 'idempotencyKey' in body)
  expect(publishBodies).toHaveLength(2)
  expect(publishBodies[1]).toEqual(publishBodies[0])
})

test('keeps channels outside the cockpit tab roster while preserving deep links', async ({ page }) => {
  await installCockpitMocks(page)
  await page.goto(testUrl)
  const cockpit = page.getByRole('navigation', { name: 'Agent cockpit' })
  await expect(cockpit.getByRole('tab')).toHaveText(['Test Chat', 'Profile', 'Directives', 'Routines', 'Skills', 'Context'])
  await page.getByRole('tab', { name: 'Profile' }).click()
  await expect(page).toHaveURL(/tab=behavior&anchor=assistant-profile/)
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await expect(page.getByText('Draft changes')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review & publish' })).toBeVisible()
  const sidebar = page.locator('[data-sidebar="sidebar"]')
  await sidebar.getByRole('button', { name: 'Channels', exact: true }).click()
  await sidebar.getByText('Manage channels', { exact: true }).click()
  await expect(page).toHaveURL(/tab=channels(?:&|$)/)
  await expect(page.getByRole('navigation', { name: 'Agent cockpit' })).toHaveCount(0)
  await sidebar.getByRole('button', { name: 'New agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Create agent', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Create manually', exact: true })).toBeVisible()
  await expect(page.getByTestId('create-agent-import-option')).toBeVisible()
})

test('leaves a routine detail when navigating to cockpit and channel sections', async ({ page }) => {
  const routineId = '55555555-5555-4555-8555-000000000001'
  const routine: RoutineFixture = {
    id: routineId,
    lineageId: routineId,
    agentId: defaultAgentId,
    name: 'Collect pricing intake',
    status: 'draft',
    version: 1,
    activation: {
      triggerDescription: 'Visitor asks about pricing.',
      gateRef: null,
      priority: 20,
      reentryMode: 'once_per_conversation',
    },
    slots: [],
    steps: [{ stableStepId: 'ask', kind: 'chat', instruction: 'Ask for the visitor email.', toolRef: null, actionType: null, ordinal: 0, metadata: {} }],
    transitions: [{ fromStep: 'ask', toRef: 'done', guardKind: 'default', guardText: null, outcomeStatus: null, counterLimit: null, ordinal: 0 }],
    terminals: [{ stableStepId: 'done', kind: 'complete', instruction: 'Done.', ordinal: 0 }],
    createdAt: nowIso,
    updatedAt: nowIso,
  }
  await installCockpitMocks(page, { routines: [routine] })
  const routineUrl = `/w/${workspaceKey}/agents/${defaultAgentId}/routines/${routineId}`

  await page.goto(routineUrl)
  const expectRoutineDetail = async () => {
    await expect(page.getByRole('heading', { name: 'Routine', level: 1, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Collect pricing intake', level: 2, exact: true })).toBeVisible()
  }
  await expectRoutineDetail()
  const cockpit = page.getByRole('navigation', { name: 'Agent cockpit' })
  await cockpit.getByRole('tab', { name: 'Profile', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=behavior&anchor=assistant-profile$`))

  await page.goto(routineUrl)
  await expectRoutineDetail()
  await page.getByRole('navigation', { name: 'Agent cockpit' }).getByRole('tab', { name: 'Test Chat', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}$`))

  await page.goto(routineUrl)
  await expectRoutineDetail()
  const sidebar = page.locator('[data-sidebar="sidebar"]')
  await sidebar.getByRole('button', { name: 'Channels', exact: true }).click()
  await sidebar.getByText('Manage channels', { exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}\\?tab=channels$`))
  await expect(page.getByRole('heading', { name: 'Channels', level: 1, exact: true })).toBeVisible()
})

test('keeps a deep-linked mobile tab visible and supports roving keyboard focus', async ({ page }) => {
  await installCockpitMocks(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-context-variables`)
  const cockpit = page.getByRole('navigation', { name: 'Agent cockpit' })
  const context = cockpit.getByRole('tab', { name: 'Context' })
  await expect(context).toBeInViewport()
  await context.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(cockpit.getByRole('tab', { name: 'Skills' })).toBeFocused()
  await expect(cockpit.getByRole('tab', { name: 'Skills' })).toBeInViewport()
})

test('saves a dirty profile draft from the persistent header', async ({ page }) => {
  await installCockpitMocks(page, { requestBodies: [], })
  const draftWrites: unknown[] = []
  await page.route(`**/backend/api/v1/agents/${defaultAgentId}`, async (route) => {
    if (route.request().method() === 'PUT') draftWrites.push(route.request().postDataJSON())
    await route.fallback()
  })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`)
  await page.locator('#assistantAnswerInstruction').fill('Use the saved draft instruction.')
  const saveDraft = page.getByRole('button', { name: 'Save draft' })
  await expect(saveDraft).toBeEnabled()
  await saveDraft.click()
  await expect.poll(() => draftWrites).toEqual(expect.arrayContaining([expect.objectContaining({ customInstruction: 'Use the saved draft instruction.' })]))
  await expect(saveDraft).toBeHidden()
  await expect(page.getByRole('button', { name: 'Review & publish' })).toBeVisible()
})

test('keeps live and private profile writes isolated while edits are interleaved', async ({ page }) => {
  const agentUpdates: unknown[] = []
  await installCockpitMocks(page, { agentUpdates })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`)
  await page.locator('#assistantAnswerInstruction').fill('Keep this private until review.')
  await page.getByLabel('Show source citations').click()
  await expect.poll(() => agentUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ citationDisplayEnabled: false })]))
  expect(agentUpdates).not.toContainEqual(expect.objectContaining({ citationDisplayEnabled: false, customInstruction: expect.anything() }))
  const saveDraft = page.getByRole('button', { name: 'Save draft' })
  await expect(saveDraft).toBeEnabled()
  await saveDraft.click()
  await expect.poll(() => agentUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ customInstruction: 'Keep this private until review.' })]))
  expect(agentUpdates).not.toContainEqual(expect.objectContaining({ customInstruction: 'Keep this private until review.', citationDisplayEnabled: false }))
})

test('does not announce a draft save for a live-only profile autosave', async ({ page }) => {
  const agentUpdates: unknown[] = []
  await installCockpitMocks(page, { agentUpdates })
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`)
  await page.evaluate(() => {
    document.body.dataset.draftSaveEvents = '0'
    window.addEventListener('radioso:agent-draft-saved', () => {
      document.body.dataset.draftSaveEvents = String(Number(document.body.dataset.draftSaveEvents ?? '0') + 1)
    })
  })

  await page.getByLabel('Show source citations').click()
  await expect.poll(() => agentUpdates).toEqual(expect.arrayContaining([expect.objectContaining({ citationDisplayEnabled: false })]))
  await expect(page.locator('body')).toHaveAttribute('data-draft-save-events', '0')
})

test('captures the populated comparison cockpit at desktop and mobile widths', async ({ page }) => {
  const question = 'My order is late — can you check its status?'
  const replies = [
    'I can help check your order status. Please share your order number and I’ll look it up.',
    'I can investigate the delay. Send your order number and the email used at checkout.',
  ]
  await installCockpitMocks(page, { replyBySide: replies })
  await page.goto(testUrl)
  await expect(page.getByRole('button', { name: 'Compare versions', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Compare versions', exact: true }).click()
  await testChatComposer(page).fill(question)
  await page.getByRole('button', { name: 'Send to both' }).click()
  await expect(page.getByText(replies[0], { exact: true })).toBeVisible()
  await expect(page.getByText(replies[1], { exact: true })).toBeVisible()
  await page.waitForTimeout(350)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-followup-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Review & publish' })).toBeVisible()
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-followup-mobile.png'), fullPage: true })
  await page.getByRole('button', { name: 'Test chat actions', exact: true }).click()
  await expect(testChatMenuItem(page, 'History')).toBeInViewport()
  await page.waitForTimeout(250)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'chat-simplification-mobile-actions.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click()
  const sidebar = page.locator('[data-sidebar="sidebar"]')
  await sidebar.getByRole('button', { name: 'Channels', exact: true }).click()
  await expect(sidebar.getByText('Manage channels', { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Agent cockpit' })).toHaveCount(0)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-followup-mobile-menu.png'), fullPage: true })
})

test('keeps the private test execution and draft inputs across cockpit navigation', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, {
    requestBodies,
    contextVariables: [{ id: 'tier', name: 'Customer tier', description: 'Current account tier', valueType: 'string' }],
    enabledContextVariableIds: ['tier'],
    revisionState: { ...revisionState, proactiveGreetingEnabled: true },
    greetingBySide: ['Welcome back to the draft test.'],
  })
  await page.goto(testUrl)

  await clickTestChatAction(page, 'Test context')
  const contextDialog = page.getByRole('dialog')
  await contextDialog.getByLabel('Customer tier').fill('enterprise')
  await page.keyboard.press('Escape')
  await testChatComposer(page).fill('Track this order')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await testChatComposer(page).fill('Keep this follow-up unsent')
  const startedTests = () => requestBodies.filter((body) =>
    body !== null && typeof body === 'object' && 'mode' in body,
  )
  const startedCount = startedTests().length

  const cockpit = page.getByRole('navigation', { name: 'Agent cockpit' })
  await cockpit.getByRole('tab', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Agent cockpit' }).getByRole('tab', { name: 'Test Chat', exact: true }).click()
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('Track this order', { exact: true })).toBeVisible()
  await expect(page.getByText('Welcome back to the draft test.', { exact: true })).toHaveCount(1)
  await expect(testChatComposer(page)).toHaveValue('Keep this follow-up unsent')
  expect(startedTests()).toHaveLength(startedCount)

  // The selected version and comparison action live in the single-chat card
  // header, alongside the independently scrollable conversation body.
  const cardSelector = page.getByRole('combobox', { name: 'Revision 1', exact: true })
  await expect(cardSelector).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Compare versions', exact: true })).toBeVisible()
  await expect(page.getByText('Published v4', { exact: true })).toHaveCount(0)
  await cardSelector.click()
  await expect(page.getByRole('option', { name: /Draft.*based on v4/, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await clickTestChatAction(page, 'Test context')
  await expect(page.getByRole('dialog').getByLabel('Customer tier')).toHaveValue('enterprise')
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('menu')).toHaveCount(0)
  await page.waitForTimeout(350)

  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-single-card-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Compare versions', exact: true })).toBeInViewport()
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-single-card-mobile.png'), fullPage: true })
})

test('keeps invalid context blocking after navigation until every field is corrected', async ({ page }) => {
  await installCockpitMocks(page, {
    contextVariables: [
      { id: 'payload-a', name: 'Payload A', description: null, valueType: 'json' },
      { id: 'payload-b', name: 'Payload B', description: null, valueType: 'json' },
    ],
    enabledContextVariableIds: ['payload-a', 'payload-b'],
  })
  await page.goto(testUrl)
  await testChatComposer(page).fill('Validate these samples')

  await clickTestChatAction(page, 'Test context')
  const contextDialog = page.getByRole('dialog')
  await expect(contextDialog.getByLabel('Payload A')).toBeVisible()
  await contextDialog.getByLabel('Payload A').fill('{bad')
  await contextDialog.getByLabel('Payload B').fill('{"ok":true}')
  await expect(contextDialog.getByRole('alert')).toContainText('Payload A must contain valid JSON.')
  await contextDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()

  const cockpit = page.getByRole('navigation', { name: 'Agent cockpit' })
  await cockpit.getByRole('tab', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Agent cockpit' }).getByRole('tab', { name: 'Test Chat', exact: true }).click()
  await expect(testChatComposer(page)).toHaveValue('Validate these samples')
  await clickTestChatAction(page, 'Test context')
  await expect(page.getByRole('dialog').getByLabel('Payload A')).toHaveValue('{bad')
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Payload A must contain valid JSON.')

  await page.getByRole('dialog').getByLabel('Payload A').fill('{"fixed":true}')
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

test('keeps the private comparison isolated while leaving and returning through Inbox', async ({ page }) => {
  const requestBodies: unknown[] = []
  await installCockpitMocks(page, { requestBodies })
  await page.goto(testUrl)

  await clickTestChatAction(page, 'Compare versions')
  const selectors = page.getByRole('combobox')
  await expect(selectors).toHaveCount(2)
  await expect(selectors.nth(0)).toHaveAttribute('aria-label', 'Revision 1')
  await expect(selectors.nth(1)).toHaveAttribute('aria-label', 'Revision 2')
  await testChatComposer(page).fill('Compare these answers')
  await page.getByRole('button', { name: 'Send to both', exact: true }).click()
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('A comparison answer.', { exact: true })).toBeVisible()
  await testChatComposer(page).fill('Do not send this comparison follow-up')
  const startedCount = requestBodies.filter((body) =>
    body !== null && typeof body === 'object' && 'mode' in body,
  ).length

  const sidebar = page.locator('[data-slot="sidebar-container"]')
  await sidebar.getByRole('link', { name: 'Inbox', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1, exact: true })).toBeVisible()
  await expect(page.getByText('Compare these answers', { exact: true })).toHaveCount(0)
  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceKey}/agents/${defaultAgentId}(?:\\?|$)`))

  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('A comparison answer.', { exact: true })).toBeVisible()
  await expect(page.getByText('Compare these answers', { exact: true })).toHaveCount(2)
  await expect(testChatComposer(page)).toHaveValue('Do not send this comparison follow-up')
  expect(requestBodies.filter((body) =>
    body !== null && typeof body === 'object' && 'mode' in body,
  )).toHaveLength(startedCount)

  // Each pane exposes its own labelled selector and answer group after the
  // comparison is restored, preserving accessible separation between sides.
  await expect(page.getByRole('combobox')).toHaveCount(2)
  await expect(page.getByRole('combobox').nth(0)).toHaveAttribute('aria-label', 'Revision 1')
  await expect(page.getByRole('combobox').nth(1)).toHaveAttribute('aria-label', 'Revision 2')
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-comparison-restored-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'cockpit-comparison-restored-mobile.png'), fullPage: true })
})

test('keeps a delayed test stream alive across cockpit navigation and completes in the remounted chat', async ({ page }) => {
  const requestBodies: unknown[] = []
  const mocks = await installCockpitMocks(page, { requestBodies, delayMessage: true })
  await page.goto(testUrl)

  await testChatComposer(page).fill('Keep this stream alive')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await mocks.messageRequest
  await expect(testChatComposer(page)).toBeDisabled()

  const cockpit = page.getByRole('navigation', { name: 'Agent cockpit' })
  await cockpit.getByRole('tab', { name: 'Profile', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Profile', level: 1, exact: true })).toBeVisible()
  await page.getByRole('navigation', { name: 'Agent cockpit' }).getByRole('tab', { name: 'Test Chat', exact: true }).click()
  await expect(page.getByText('Keep this stream alive', { exact: true })).toBeVisible()
  await expect(testChatComposer(page)).toBeDisabled()

  mocks.releaseMessage()
  await expect(page.getByText('A fenced answer.', { exact: true })).toBeVisible()
  await expect(testChatComposer(page)).toBeEnabled()
  await testChatComposer(page).fill('Ready for another turn')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  expect(requestBodies.filter((body) =>
    body !== null && typeof body === 'object' && 'mode' in body,
  )).toHaveLength(1)
})

test('captures Fable recheck evidence for live settings and publication review', async ({ page }) => {
  await installCockpitMocks(page)
  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-profile`)
  await expect(page.getByText('Applies live now').first()).toBeVisible()
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'agent-cockpit-fable-profile-live-caption.png'), fullPage: true })

  await page.goto(`/w/${workspaceKey}/agents/${defaultAgentId}?tab=behavior&anchor=assistant-context-variables`)
  await expect(page.getByText('Shared variable definitions apply live')).toBeVisible()
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'agent-cockpit-fable-context-live-caption.png'), fullPage: true })
  await page.getByRole('button', { name: 'Add variable' }).click()
  await expect(page.getByRole('dialog')).toContainText('Shared definition — changes apply live')
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'agent-cockpit-fable-shared-definition-dialog.png'), fullPage: true })
  await page.getByRole('button', { name: 'Cancel' }).click()

  await page.goto(testUrl)
  await page.getByRole('button', { name: 'Review & publish' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.waitForTimeout(300)
  await page.screenshot({ path: resolve(process.cwd(), '..', '.context', 'agent-cockpit-fable-publication-dialog.png'), fullPage: true })
})
