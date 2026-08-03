import { expect, test } from '@playwright/test'

import { installDashboardApiMocks, seedDashboardStorage, workspaceKey } from './dashboard-fixtures'

test('account usage exposes separate message and internal AI usage views', async ({ page }) => {
  const requestLog: string[] = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, { requestLog })

  await page.goto(`/w/${workspaceKey}/usage`)
  await page.getByRole('tab', { name: 'AI usage' }).click()

  const details = page.getByTestId('usage-details')
  await expect(details.getByText('Detailed AI usage')).toBeVisible()
  await expect(details.getByRole('table', { name: 'Message AI usage' })).toBeVisible()
  await expect(details.getByRole('columnheader', { name: 'Model input' })).toBeVisible()
  await expect(details.getByRole('columnheader', { name: 'Reasoning' })).toBeVisible()
  await expect(details.getByRole('columnheader', { name: 'Output' })).toBeVisible()
  await expect(details.getByRole('columnheader', { name: 'LLM Calls' })).toBeVisible()
  await expect(details.getByText('Assistant response')).toBeVisible()
  await expect(details.getByText('Provider: openai')).toBeVisible()
  await expect(details.getByText(/Model: gpt-5\.2, text-embedding-3-small/)).toBeVisible()
  await expect(details.getByText('Workspace: Default')).toBeVisible()
  await expect(details.getByText('1 vectors')).toBeVisible()
  await expect(details.getByText('Reasoning not reported separately')).toBeVisible()
  await expect(details.getByRole('cell', { name: '2', exact: true })).toBeVisible()
  await expect(details.getByText('2 succeeded · 0 failed')).toHaveCount(0)
  const messageLink = details.getByRole('link', { name: /Open message from/ })
  await expect(messageLink).toHaveAttribute(
    'href',
    '/w/workspace-key/activity?tab=all&filter=chat&itemKind=chat&itemId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&itemMessageId=11111111-1111-4111-8111-111111111111',
  )
  await expect(details.getByText('A visitor message must never be rendered in Usage.')).toHaveCount(0)
  await expect
    .poll(() => requestLog.some((entry) => entry.startsWith('GET /account/usage/messages')))
    .toBe(true)

  await details.getByRole('button', { name: 'Load more' }).click()
  await expect
    .poll(() => requestLog.some((entry) => entry.includes('/account/usage/messages') && entry.includes('cursor=next-message-page')))
    .toBe(true)

  await details.getByRole('tab', { name: 'Internal operations' }).click()
  await expect(details.getByRole('table', { name: 'Internal AI usage' })).toBeVisible()
  await expect(details.getByText('Metadata generation')).toBeVisible()
  await expect(details.getByText('Agent setup')).toBeVisible()
  await expect(details.getByRole('table', { name: 'Internal AI usage' }).getByText('Workspace: Default').first()).toBeVisible()
  await expect(details.getByText('Embedding', { exact: true })).toBeVisible()
  await expect
    .poll(() => requestLog.some((entry) => entry.startsWith('GET /account/usage/internal-operations')))
    .toBe(true)

  await details.getByLabel('Detailed usage workspace').click()
  await page.getByRole('option', { name: 'Default' }).click()
  await details.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page).toHaveURL(/usageWorkspace=workspace-1/)
  await expect
    .poll(() => requestLog.some((entry) => entry.includes('/account/usage/internal-operations') && entry.includes('workspaceId=workspace-1')))
    .toBe(true)
})

test('does not append a stale detailed-usage page after filters change', async ({ page }) => {
  const requestLog: string[] = []
  await seedDashboardStorage(page)
  await installDashboardApiMocks(page, {
    requestLog,
    messageUsageLoadMoreDelayMs: 1_000,
    messageUsageNextPage: {
      from: '2026-05-28',
      to: '2026-06-26',
      filters: { workspaceId: null },
      items: [
        {
          messageId: '44444444-4444-4444-8444-444444444444',
          conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          workspaceId: 'workspace-1',
          agentId: 'agent-1',
          lastOccurredAt: '2026-06-26T12:00:00.000Z',
          providers: ['openai'],
          models: ['gpt-5.2'],
          operations: [{ surface: 'assistant', name: 'respond', label: 'Stale pagination record' }],
          attempts: { total: 1, succeeded: 1, failed: 0 },
          quality: { actual: 1, estimated: 0 },
          modelTokens: {
            input: 10,
            completion: 5,
            reasoning: { tokens: 1, coverage: 'complete' },
            visibleOutput: 4,
            total: 15,
          },
          embeddingTokens: { input: 0, total: 0, vectors: 0, attempts: 0 },
          unknownHistorical: { total: 0, attempts: 0 },
        },
      ],
      nextCursor: null,
    },
  })

  await page.goto(`/w/${workspaceKey}/usage`)
  await page.getByRole('tab', { name: 'AI usage' }).click()

  const details = page.getByTestId('usage-details')
  await expect(details.getByRole('table', { name: 'Message AI usage' })).toBeVisible()
  await details.getByRole('button', { name: 'Load more' }).click()
  await expect(details.getByRole('button', { name: 'Loading more…' })).toBeVisible()

  await details.locator('#usage-details-from').fill('2026-06-01')
  await details.getByRole('button', { name: 'Apply filters' }).click()
  await expect(page).toHaveURL(/usageFrom=2026-06-01/)
  await expect
    .poll(() => requestLog.some((entry) => entry.includes('/account/usage/messages') && entry.includes('from=2026-06-01')))
    .toBe(true)

  await expect(details.getByRole('button', { name: 'Load more' })).toBeVisible()
  await expect(details.getByText('Stale pagination record')).toHaveCount(0)
})
