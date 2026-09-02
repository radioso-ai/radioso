import { afterEach, describe, expect, it, vi } from 'vitest'

import { slackSkillsApi } from '@/lib/api-slack-skills'

const createLocalStorage = () => {
  const store = new Map<string, string>([
    ['radioso.activeWorkspaceId', 'workspace-1'],
  ])

  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
  }
}

const createJsonResponse = (payload: unknown, status = 200) => ({
  ok: true,
  status,
  headers: {
    get: () => 'application/json',
  },
  json: async () => payload,
})

describe('slackSkillsApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates Slack skills through the agent-scoped endpoint', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ skill: { id: 'skill-1' } }))
    vi.stubGlobal('fetch', fetchMock)

    await slackSkillsApi.create('agent-1', {
      skillName: 'post_to_slack',
      installationId: '99999999-9999-4999-8999-000000000003',
      boundInputs: { channelId: 'C123' },
      exposedInputs: { text: { slotBinding: 'message', required: true } },
      enabled: true,
    })

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/agents/agent-1/slack-skills')
    expect(requestInit.method).toBe('POST')
    expect(requestInit.body).toBe(JSON.stringify({
      skillName: 'post_to_slack',
      installationId: '99999999-9999-4999-8999-000000000003',
      boundInputs: { channelId: 'C123' },
      exposedInputs: { text: { slotBinding: 'message', required: true } },
      enabled: true,
    }))
    expect(new Headers(requestInit.headers).get('Authorization')).toBeNull()
  })

  it('toggles Slack skills without sending credentials', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({ skill: { id: 'skill-1', enabled: false } }))
    vi.stubGlobal('fetch', fetchMock)

    await slackSkillsApi.update('agent-1', 'skill-1', { enabled: false })

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/agents/agent-1/slack-skills/skill-1')
    expect(requestInit.method).toBe('PATCH')
    expect(requestInit.body).toBe(JSON.stringify({ enabled: false }))
  })
})
