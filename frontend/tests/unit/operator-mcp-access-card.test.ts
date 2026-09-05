import { describe, expect, it } from 'vitest'

import {
  isOperatorMcpResource,
  selectOperatorMcpArtifactId,
} from '@/components/dashboard/settings/operator-mcp-access-card'

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

describe('operator MCP setup selection', () => {
  it('selects the first setup tab when no tab is already selected', () => {
    expect(selectOperatorMcpArtifactId([
      { id: 'codex-cli', status: 'unverified' },
      { id: 'claude-code', status: 'unverified' },
      { id: 'cursor', status: 'unverified' },
      { id: 'generic', status: 'unverified' },
    ] as const, null)).toBe('codex-cli')
  })

  it('keeps a selected setup tab', () => {
    const artifacts = [
      { id: 'codex-cli', status: 'unverified' as const },
      { id: 'generic', status: 'unverified' as const },
    ]
    expect(selectOperatorMcpArtifactId(artifacts, 'generic')).toBe('generic')
    expect(selectOperatorMcpArtifactId(artifacts, 'codex-cli')).toBe('codex-cli')
  })
})
