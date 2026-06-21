import { afterEach, describe, expect, it, vi } from 'vitest'

import { slackApi } from '@/lib/api-slack'

const createLocalStorage = () => {
  const store = new Map<string, string>([
    ['radioso.activeWorkspaceId', 'workspace-1'],
    ['radioso.workspaceTokens', JSON.stringify({ 'workspace-1': 'workspace-token' })],
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

describe('slackApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('starts Slack installation through the workspace Slack endpoint', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({
      authorizationUrl: 'https://slack.com/oauth/v2/authorize',
      connectionId: '99999999-9999-4999-8999-000000000002',
      status: 'pending',
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(slackApi.startInstall('workspace-1', 'agent-1')).resolves.toMatchObject({
      status: 'pending',
    })

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/workspaces/workspace-1/slack/install/start')
    expect(requestInit.method).toBe('POST')
    expect(requestInit.credentials).toBe('omit')
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer workspace-token')
  })

  it('updates the Slack answering binding with a typed JSON body', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({
      answeringAgentId: 'agent-1',
      escalationChannelId: null,
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(slackApi.updateBinding('workspace-1', 'agent-1', {
      answeringAgentId: 'agent-1',
      escalationChannelId: null,
    })).resolves.toEqual({
      answeringAgentId: 'agent-1',
      escalationChannelId: null,
    })

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/workspaces/workspace-1/slack/binding')
    expect(requestInit.method).toBe('PUT')
    expect(requestInit.body).toBe(JSON.stringify({
      answeringAgentId: 'agent-1',
      escalationChannelId: null,
    }))
    expect(new Headers(requestInit.headers).get('Content-Type')).toBe('application/json')
  })

  it('fetches the self-host Slack manifest through the workspace Slack endpoint', async () => {
    vi.stubGlobal('window', { localStorage: createLocalStorage() })
    const fetchMock = vi.fn().mockResolvedValue(createJsonResponse({
      manifest: {
        oauth_config: {
          redirect_urls: ['https://self-host.example.com/api/v1/oauth/callback/slack'],
        },
      },
      requiredEnvVars: ['SLACK_OAUTH_CLIENT_ID', 'SLACK_OAUTH_CLIENT_SECRET', 'SLACK_SIGNING_SECRET'],
    }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(slackApi.getManifest('workspace-1', 'agent-1')).resolves.toMatchObject({
      requiredEnvVars: ['SLACK_OAUTH_CLIENT_ID', 'SLACK_OAUTH_CLIENT_SECRET', 'SLACK_SIGNING_SECRET'],
    })

    const [requestUrl, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(requestUrl).toBe('/backend/api/v1/workspaces/workspace-1/slack/manifest')
    expect(requestInit.method).toBe('GET')
    expect(new Headers(requestInit.headers).get('Authorization')).toBe('Bearer workspace-token')
  })
})
