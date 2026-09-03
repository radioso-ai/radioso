import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MCP_CLIENT_ID,
  GENERIC_MCP_CLIENT_ID,
  MCP_CLIENT_SETUPS,
  MCP_SERVER_NAME,
  getMcpClientSetup,
} from '@/lib/mcp-client-setups'

const MCP_URL = 'https://mcp.example.com/mcp'
const SECRET = 'radioso_mcp_v1_secret'

describe('MCP client setup catalog', () => {
  it('offers every client the connect dialog lists', () => {
    expect(MCP_CLIENT_SETUPS.map((setup) => setup.id)).toEqual([
      'claude-desktop',
      'claude-code',
      'cursor',
      'other',
    ])
  })

  it('gives every client at least one setup step', () => {
    for (const setup of MCP_CLIENT_SETUPS) {
      expect(setup.steps.length).toBeGreaterThan(0)
    }
  })

  it('builds a Claude Code command that carries the credential as a bearer header', () => {
    const snippet = getMcpClientSetup('claude-code').buildSnippet(MCP_URL, SECRET)

    expect(snippet).toContain(`claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_URL}`)
    expect(snippet).toContain(`--header "Authorization: Bearer ${SECRET}"`)
  })

  it('builds a JSON server block for configuration-file clients', () => {
    for (const id of ['claude-desktop', 'cursor', 'other'] as const) {
      const parsed: unknown = JSON.parse(getMcpClientSetup(id).buildSnippet(MCP_URL, SECRET))

      expect(parsed).toEqual({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            url: MCP_URL,
            headers: { Authorization: `Bearer ${SECRET}` },
          },
        },
      })
    }
  })

  it('resolves the default and generic entries', () => {
    expect(getMcpClientSetup(DEFAULT_MCP_CLIENT_ID).name).toBe('Claude Desktop')
    expect(getMcpClientSetup(GENERIC_MCP_CLIENT_ID).name).toBe('Other MCP client')
  })
})
