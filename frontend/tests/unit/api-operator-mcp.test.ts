import { afterEach, describe, expect, it, vi } from 'vitest'

import { operatorMcpApi } from '@/lib/api-operator-mcp'

afterEach(() => vi.unstubAllGlobals())

describe('operator MCP API adapter', () => {
  it('uses encoded workspace paths and session anti-forgery headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ availability: 'disabled', artifacts: [], resource: null, checkedAt: 'now', message: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await operatorMcpApi.getSetup('workspace/with spaces')

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/backend/api/v1/workspaces/workspace%2Fwith%20spaces/operator-mcp/setup')
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'include' })
    expect(new Headers(init.headers).get('X-Radioso-CSRF')).toBe('1')
    expect(new Headers(init.headers).get('X-Forwarded-Prefix')).toBe('/backend')
  })

  it('posts only the consent decision and selected authority', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ redirectUrl: 'https://client.example/cb?code=one&state=two' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)

    await operatorMcpApi.decideTransaction('tx/1', {
      decision: 'approve',
      workspaceId: 'workspace-1',
      approvedToolScopes: ['operator:read'],
      offlineAccess: false,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/backend/api/v1/operator-mcp/oauth/transactions/tx%2F1/decision',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ decision: 'approve', workspaceId: 'workspace-1', approvedToolScopes: ['operator:read'], offlineAccess: false }),
      }),
    )
  })
})
