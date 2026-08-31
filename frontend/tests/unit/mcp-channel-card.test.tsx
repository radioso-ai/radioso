import { describe, expect, it } from 'vitest'

import { buildClientConfig, resolveMcpChannelSetup, shouldProbeMcpHealth } from '@/components/dashboard/settings/mcp-channel-card'

describe('MCP channel card setup mode', () => {
  it('uses same-host setup when the MCP URL resolves to the dashboard origin', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'https://radioso.example.com/mcp',
    })

    expect(setup.mode).toBe('same-host')
    expect(setup.label).toBe('Same-host setup')
    expect(setup.steps).toEqual([
      "Open your AI client's MCP settings.",
      'Paste the MCP server URL.',
      'Paste a personal token or service-account credential from Workspace settings → API access directly.',
    ])
    expect(buildClientConfig(setup.mcpUrl, setup.authorizationPlaceholder)).toContain('Bearer <credential from Workspace settings>')
  })

  it('keeps relative MCP URLs in same-host setup before the browser origin is known', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: '',
      mcpUrl: '/backend/mcp',
    })

    expect(setup.mode).toBe('same-host')
    expect(setup.mcpUrl).toBe('/backend/mcp')
    expect(buildClientConfig(setup.mcpUrl, setup.authorizationPlaceholder)).toContain('Bearer <credential from Workspace settings>')
  })

  it('keeps remote exchange instructions when the MCP URL uses a different origin', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'https://mcp.example.com/mcp',
    })

    expect(setup.mode).toBe('remote')
    expect(setup.label).toBe('Remote setup')
    expect(setup.steps.some((step) => step.includes('Create a personal token or service-account credential'))).toBe(true)
    expect(buildClientConfig(setup.mcpUrl, setup.authorizationPlaceholder)).toContain('Bearer <MCP access token>')
    expect(shouldProbeMcpHealth(setup)).toBe(false)
  })

  it('uses the backend health endpoint for same-host MCP setup', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: '/backend/mcp',
    })

    expect(shouldProbeMcpHealth(setup)).toBe(true)
  })

  it('marks MCP unavailable when no MCP URL is configured', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: '',
    })

    expect(setup.mode).toBe('disabled')
    expect(setup.label).toBe('MCP not enabled')
    expect(setup.error).toBe('MCP is not enabled on this deployment.')
    expect(setup.remediation).toContain('RADIOSO_MCP_ENABLED')
  })

  it('returns a clear error for invalid MCP URLs', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'http://[bad-url',
    })

    expect(setup.mode).toBe('disabled')
    expect(setup.error).toBe('The configured MCP URL is invalid.')
    expect(setup.remediation).toContain('NEXT_PUBLIC_MCP_URL')
  })
})
