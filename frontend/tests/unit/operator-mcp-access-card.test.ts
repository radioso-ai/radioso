import { describe, expect, it } from 'vitest'

import { isOperatorMcpResource } from '@/components/dashboard/settings/operator-mcp-access-card'

describe('operator MCP resource validation', () => {
  it('accepts only the canonical HTTPS operator resource', () => {
    expect(isOperatorMcpResource('https://mcp.example.com/operator/mcp')).toBe(true)
    expect(isOperatorMcpResource('http://localhost:8787/operator/mcp')).toBe(true)
  })

  it('rejects authored-agent MCP paths and URL decorations', () => {
    expect(isOperatorMcpResource('https://mcp.example.com/mcp')).toBe(false)
    expect(isOperatorMcpResource('https://mcp.example.com/operator/mcp?workspace=one')).toBe(false)
    expect(isOperatorMcpResource('http://mcp.example.com/operator/mcp')).toBe(false)
  })
})
