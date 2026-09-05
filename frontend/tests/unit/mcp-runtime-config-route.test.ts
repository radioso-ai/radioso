import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/runtime-config/route'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runtime configuration route', () => {
  it('exposes the standalone MCP URL and canonical API origin at request time', async () => {
    vi.stubEnv('RADIOSO_MCP_PUBLIC_URL', 'https://radioso-mcp.example.com/mcp')
    vi.stubEnv('RADIOSO_PUBLIC_API_URL', 'https://api.example.com')

    const response = GET()

    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      mcpUrl: 'https://radioso-mcp.example.com/mcp',
      publicApiUrl: 'https://api.example.com',
    })
  })

  it('reports empty values when neither surface is configured', async () => {
    vi.stubEnv('RADIOSO_MCP_PUBLIC_URL', '')
    vi.stubEnv('RADIOSO_PUBLIC_API_URL', '')

    const response = GET()

    await expect(response.json()).resolves.toEqual({ mcpUrl: '', publicApiUrl: '' })
  })
})
