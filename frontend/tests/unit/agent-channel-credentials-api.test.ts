import { afterEach, describe, expect, it, vi } from 'vitest'

import { agentChannelCredentialsApi } from '@/lib/api-agent-channel-credentials'

const response = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  json: async () => payload,
})

describe('agentChannelCredentialsApi', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses one lifecycle convention while keeping MCP and REST audiences explicit', async () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'workspace-1' },
      document: { cookie: '' },
    })
    const fetchMock = vi.fn().mockResolvedValue(response({ credentials: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await agentChannelCredentialsApi.list('agent-1', 'mcp')
    await agentChannelCredentialsApi.issue('agent-1', {
      audience: 'rest',
      label: 'Production chat',
      expiresAt: '2026-11-29T23:59:59.000Z',
    })
    await agentChannelCredentialsApi.rotate('agent-1', 'credential-1')
    await agentChannelCredentialsApi.revoke('agent-1', 'credential-1')

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/backend/api/v1/agents/agent-1/channel-credentials?audience=mcp')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/backend/api/v1/agents/agent-1/channel-credentials')
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string)).toEqual({
      audience: 'rest',
      label: 'Production chat',
      expiresAt: '2026-11-29T23:59:59.000Z',
    })
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/backend/api/v1/agents/agent-1/channel-credentials/credential-1/rotate')
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/backend/api/v1/agents/agent-1/channel-credentials/credential-1/revoke')
    expect(fetchMock.mock.calls.slice(1).every((call) => call[1]?.credentials === 'include')).toBe(true)
    expect(fetchMock.mock.calls.slice(1).every((call) => new Headers(call[1]?.headers).get('X-Radioso-CSRF') === '1')).toBe(true)
  })
})
