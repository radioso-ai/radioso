import { describe, expect, it } from 'vitest'

import { buildAgentChatEndpoint, parseRuntimeConfig, resolveApiBaseUrl } from '@/lib/runtime-config'

describe('parseRuntimeConfig', () => {
  it('reads both deployment values', () => {
    expect(parseRuntimeConfig({ mcpUrl: 'https://mcp.example.com/mcp', operatorMcpUrl: 'https://mcp.example.com/operator/mcp', publicApiUrl: 'https://api.example.com' }))
      .toEqual({ mcpUrl: 'https://mcp.example.com/mcp', operatorMcpUrl: 'https://mcp.example.com/operator/mcp', publicApiUrl: 'https://api.example.com' })
  })

  it('falls back to empty values for a malformed body', () => {
    expect(parseRuntimeConfig(null)).toEqual({ mcpUrl: '', operatorMcpUrl: '', publicApiUrl: '' })
    expect(parseRuntimeConfig('nope')).toEqual({ mcpUrl: '', operatorMcpUrl: '', publicApiUrl: '' })
    expect(parseRuntimeConfig({ mcpUrl: 7 })).toEqual({ mcpUrl: '', operatorMcpUrl: '', publicApiUrl: '' })
  })
})

describe('resolveApiBaseUrl', () => {
  const dashboardOrigin = 'https://dashboard.example.com'
  const basePath = '/backend/api/v1'

  it('uses the dashboard origin and proxy path when no canonical origin is configured', () => {
    expect(resolveApiBaseUrl({ publicApiUrl: '', dashboardOrigin, basePath }))
      .toBe('https://dashboard.example.com/backend/api/v1')
  })

  it('ignores a blank canonical origin', () => {
    expect(resolveApiBaseUrl({ publicApiUrl: '   ', dashboardOrigin, basePath }))
      .toBe('https://dashboard.example.com/backend/api/v1')
  })

  it('appends the public API path to a canonical origin', () => {
    expect(resolveApiBaseUrl({ publicApiUrl: 'https://api.radioso.ai', dashboardOrigin, basePath }))
      .toBe('https://api.radioso.ai/api/v1')
  })

  it('tolerates a trailing slash on the canonical origin', () => {
    expect(resolveApiBaseUrl({ publicApiUrl: 'https://api.radioso.ai/', dashboardOrigin, basePath }))
      .toBe('https://api.radioso.ai/api/v1')
  })

  it('keeps a canonical value that already names the public API path', () => {
    expect(resolveApiBaseUrl({ publicApiUrl: 'https://api.radioso.ai/api/v1', dashboardOrigin, basePath }))
      .toBe('https://api.radioso.ai/api/v1')
  })
})

describe('buildAgentChatEndpoint', () => {
  it('addresses the agent chat turn on the resolved base', () => {
    expect(buildAgentChatEndpoint('https://api.radioso.ai/api/v1', 'agent-1'))
      .toBe('https://api.radioso.ai/api/v1/agents/agent-1/chat')
  })
})
