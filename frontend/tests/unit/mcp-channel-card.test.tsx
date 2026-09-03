import { describe, expect, it } from 'vitest'

import { resolveMcpChannelSetup } from '@/components/dashboard/settings/mcp-channel-card'

describe('MCP channel card setup mode', () => {
  it('enables the card for a standalone MCP origin', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'https://mcp.example.com/mcp',
    })

    expect(setup.mode).toBe('enabled')
    expect(setup.mcpUrl).toBe('https://mcp.example.com/mcp')
  })

  it('treats an unconfigured MCP URL as not enabled', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: '',
    })

    expect(setup).toEqual({ mcpUrl: '', mode: 'disabled' })
  })

  it('treats the dashboard-origin MCP URL as not enabled', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'https://radioso.example.com/mcp',
    })

    expect(setup).toEqual({ mcpUrl: '', mode: 'disabled' })
  })

  it('treats a root-relative MCP path as not enabled', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: '',
      mcpUrl: '/backend/mcp',
    })

    expect(setup).toEqual({ mcpUrl: '', mode: 'disabled' })
  })

  it('treats an unparseable MCP URL as not enabled', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'http://[bad-url',
    })

    expect(setup).toEqual({ mcpUrl: '', mode: 'disabled' })
  })
})
