import { describe, expect, it } from 'vitest'

import { buildConverseClientConfig } from '@/lib/mcp-converse-client-config'

describe('buildConverseClientConfig', () => {
  it('builds MCP client JSON with the converse grant bearer token', () => {
    const config = buildConverseClientConfig('https://radioso.example.com/backend/mcp', 'radioso_mcp_converse_plaintext')

    expect(JSON.parse(config)).toEqual({
      mcpServers: {
        radioso: {
          url: 'https://radioso.example.com/backend/mcp',
          headers: {
            Authorization: 'Bearer radioso_mcp_converse_plaintext',
          },
        },
      },
    })
  })

  it('escapes token and URL values through JSON serialization', () => {
    const config = buildConverseClientConfig('https://radioso.example.com/mcp?name="agent"', 'token-with-"quote"')

    expect(() => JSON.parse(config)).not.toThrow()
    expect(config).toContain('\\"agent\\"')
    expect(JSON.parse(config).mcpServers.radioso.headers.Authorization).toBe('Bearer token-with-"quote"')
  })
})
