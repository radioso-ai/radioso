import { describe, expect, it } from 'vitest'

import { buildAgentMcpConnectDetails } from '@/lib/agent-mcp-connect'

describe('agent MCP connect details', () => {
  it('uses the deployment MCP and API hosts for a public agent without inventing a host', () => {
    expect(buildAgentMcpConnectDetails({
      dashboardOrigin: 'https://app.radioso.ai',
      mcpUrl: 'https://mcp.radioso.ai/mcp/',
      publicApiUrl: 'https://api.radioso.ai',
      publicId: 'ag_public',
    })).toEqual({
      endpoint: 'https://mcp.radioso.ai/mcp/a/ag_public',
      discoveryCardUrl: 'https://api.radioso.ai/.well-known/agent-card/ag_public.json',
    })
  })

  it('uses the dashboard host for a single-host deployment with no public API override', () => {
    expect(buildAgentMcpConnectDetails({
      dashboardOrigin: 'https://radioso.example.com',
      mcpUrl: 'https://mcp.radioso.example.com/mcp',
      publicApiUrl: '',
      publicId: 'ag_public',
    }).discoveryCardUrl).toBe('https://radioso.example.com/.well-known/agent-card/ag_public.json')
  })
})
