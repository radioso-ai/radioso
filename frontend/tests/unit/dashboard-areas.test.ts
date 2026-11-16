import { describe, expect, it } from 'vitest'

import {
  AGENT_DELETE_ANCHOR,
  agentRowForSection,
  agentSectionFromRoute,
  agentSectionRoute,
  type AgentRowId,
  type AgentSectionId,
} from '@/lib/dashboard-areas'

describe('agent menu rows', () => {
  const expectedRows: Record<AgentSectionId, AgentRowId> = {
    profile: 'build',
    directives: 'build',
    routines: 'build',
    skills: 'build',
    'context-variables': 'build',
    changes: 'build',
    chat: 'test',
    'channels-overview': 'channels',
    'web-chat': 'channels',
    'api-channel': 'channels',
    'mcp-channel': 'channels',
    'slack-channel': 'channels',
    'whatsapp-channel': 'channels',
    'email-channel': 'channels',
  }

  it.each(Object.entries(expectedRows))('%s sits under the %s row', (section, row) => {
    expect(agentRowForSection(section as AgentSectionId)).toBe(row)
  })

  it('highlights Build for a routine detail page', () => {
    expect(agentRowForSection(agentSectionFromRoute({ agentRoutineId: 'routine-1' }))).toBe('build')
  })

  it('highlights Test for the chat tab, history and saved-test views included', () => {
    expect(agentRowForSection(agentSectionFromRoute({ agentTab: 'chat' }))).toBe('test')
  })

  it('maps every section route back to the same section', () => {
    for (const section of Object.keys(expectedRows) as AgentSectionId[]) {
      const { agentTab, anchor } = agentSectionRoute(section)
      expect(agentSectionFromRoute({ agentTab, anchor })).toBe(section)
    }
  })
})

describe('agent landing and old links', () => {
  it('opens an agent on Build, Profile', () => {
    expect(agentSectionFromRoute({})).toBe('profile')
    expect(agentRowForSection(agentSectionFromRoute({}))).toBe('build')
  })

  it('opens Test for the chat tab and Profile for the behavior tab', () => {
    expect(agentSectionFromRoute({ agentTab: 'chat' })).toBe('chat')
    expect(agentSectionFromRoute({ agentTab: 'behavior' })).toBe('profile')
  })

  it('opens the channel page a channel anchor names, and the overview for none', () => {
    expect(agentSectionFromRoute({ agentTab: 'channels', anchor: 'slack-channel' })).toBe('slack-channel')
    expect(agentSectionFromRoute({ agentTab: 'channels', anchor: 'website-embed' })).toBe('web-chat')
    expect(agentSectionFromRoute({ agentTab: 'channels' })).toBe('channels-overview')
  })

  it('opens Profile for the delete anchor, which the agent view turns into the confirmation', () => {
    expect(AGENT_DELETE_ANCHOR).toBe('agent-danger-zone')
    expect(agentSectionFromRoute({ agentTab: 'behavior', anchor: AGENT_DELETE_ANCHOR })).toBe('profile')
  })
})
