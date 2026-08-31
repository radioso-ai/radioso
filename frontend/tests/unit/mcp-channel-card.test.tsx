import { describe, expect, it } from 'vitest'

import { buildClientConfig, resolveMcpChannelSetup, shouldProbeMcpHealth } from '@/components/dashboard/settings/mcp-channel-card'

describe('MCP channel card setup mode', () => {
  it('marks same-host merged MCP as unavailable', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'https://radioso.example.com/mcp',
    })

    expect(setup.mode).toBe('disabled')
    expect(setup.label).toBe('MCP unavailable')
    expect(setup.error).toContain('merged MCP endpoint is unavailable')
    expect(setup.steps).toEqual([])
  })

  it('marks relative same-host merged MCP as unavailable', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: '',
      mcpUrl: '/backend/mcp',
    })

    expect(setup.mode).toBe('disabled')
    expect(setup.label).toBe('MCP unavailable')
    expect(setup.mcpUrl).toBe('/backend/mcp')
    expect(setup.error).toContain('merged MCP endpoint is unavailable')
  })

  it('keeps remote exchange instructions when the MCP URL uses a different origin', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'https://mcp.example.com/mcp',
    })

    expect(setup.mode).toBe('remote')
    expect(setup.label).toBe('Remote setup')
    expect(setup.steps.some((step) => step.includes('Create an MCP converse credential'))).toBe(true)
    expect(buildClientConfig(setup.mcpUrl, setup.authorizationPlaceholder)).toContain('Bearer <MCP converse grant token>')
    expect(shouldProbeMcpHealth(setup)).toBe(false)
  })

  it('does not probe the unavailable same-host merged MCP endpoint', () => {
    const setup = resolveMcpChannelSetup({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: '/backend/mcp',
    })

    expect(shouldProbeMcpHealth(setup)).toBe(false)
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
