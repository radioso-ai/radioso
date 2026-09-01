import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET } from '@/app/runtime-config/route'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('MCP runtime configuration route', () => {
  it('exposes the standalone MCP URL at request time', async () => {
    vi.stubEnv('RADIOSO_MCP_PUBLIC_URL', 'https://radioso-mcp.example.com/mcp')

    const response = await GET()

    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ mcpUrl: 'https://radioso-mcp.example.com/mcp' })
  })

  it('does not invent a merged backend MCP URL when MCP is disabled', async () => {
    vi.stubEnv('RADIOSO_MCP_PUBLIC_URL', '')

    const response = await GET()

    await expect(response.json()).resolves.toEqual({ mcpUrl: '' })
  })
})
