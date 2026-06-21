import { describe, expect, it } from 'vitest'

import {
  areDashboardRouteStatesEqual,
  buildAccountRoute,
  buildDashboardHref,
  buildLegacyDashboardHref,
  type DashboardRouteState,
  parseDashboardRoute,
  retargetDashboardRouteToWorkspace,
} from '@/lib/dashboard-routes'
import { buildActivityTabHref } from '@/components/dashboard/activity-tabs'
import { agentSectionFromRoute, agentSectionRoute } from '@/lib/dashboard-areas'

describe('dashboard route state', () => {
  it('builds a canonical agent route with workspace key and selected tab state', () => {
    const href = buildDashboardHref('account-1', {
      section: 'agents',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'support-abc123',
      agentTab: 'behavior',
    })

    expect(href).toBe('/w/support-abc123/agents?tab=behavior')
  })

  it('builds a canonical knowledge document deep link with workspace key and page state', () => {
    const href = buildDashboardHref('account-1', {
      section: 'knowledge',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'support-abc123',
      documentId: 'doc-9',
      documentsPage: 3,
    })

    expect(href).toBe('/w/support-abc123/knowledge/documents/doc-9?page=3')
  })

  it('builds and parses the knowledge sources tab', () => {
    expect(buildDashboardHref('account-1', {
      section: 'knowledge',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'support-abc123',
      knowledgeTab: 'sources',
    })).toBe('/w/support-abc123/knowledge?tab=sources')

    expect(parseDashboardRoute(['knowledge'], new URLSearchParams({ tab: 'sources' }))).toEqual({
      section: 'knowledge',
      knowledgeTab: 'sources',
    })
  })

  it('parses activity filter, page, and selected item state', () => {
    const params = new URLSearchParams({
      workspace: 'workspace-2',
      filter: 'search',
      page: '4',
      itemKind: 'search',
      itemId: 'search-77',
    })

    expect(parseDashboardRoute(['activity'], params)).toEqual({
      section: 'activity',
      workspaceId: 'workspace-2',
      historyFilter: 'search',
      historyPage: 4,
      historyItemKind: 'search',
      historyItemId: 'search-77',
    })
  })

  it('parses contact activity filter and selected request state', () => {
    const params = new URLSearchParams({
      filter: 'contact',
      itemKind: 'contact',
      itemId: 'request-77',
    })

    expect(parseDashboardRoute(['activity'], params)).toEqual({
      section: 'activity',
      historyFilter: 'contact',
      historyItemKind: 'contact',
      historyItemId: 'request-77',
    })
  })

  it('round-trips activity tab state while preserving activity deep links', () => {
    expect(buildDashboardHref('account-1', {
      section: 'activity',
      workspacePublicRouteKey: 'support-abc123',
      activityTab: 'needs-attention',
    })).toBe('/w/support-abc123/activity')

    expect(buildDashboardHref('account-1', {
      section: 'activity',
      workspacePublicRouteKey: 'support-abc123',
      activityTab: 'all',
    })).toBe('/w/support-abc123/activity?tab=all')

    const parsed = parseDashboardRoute(['activity'], new URLSearchParams({
      tab: 'needs-attention',
      filter: 'chat',
      itemKind: 'chat',
      itemId: 'conversation-1',
      itemMessageId: 'message-1',
    }))

    expect(parsed).toEqual({
      section: 'activity',
      // 'needs-attention' is the default tab, so it normalizes out of the parsed state.
      historyFilter: 'chat',
      historyItemKind: 'chat',
      historyItemId: 'conversation-1',
      historyMessageId: 'message-1',
    })

    expect(buildDashboardHref('account-1', {
      ...parsed!,
      workspacePublicRouteKey: 'support-abc123',
    })).toBe('/w/support-abc123/activity?filter=chat&itemKind=chat&itemId=conversation-1&itemMessageId=message-1')
  })

  it('builds activity tab hrefs without discarding active surface filters', () => {
    const filteredActivity: DashboardRouteState = {
      section: 'activity',
      workspacePublicRouteKey: 'support-abc123',
      activityTab: 'all',
      historyFilter: 'chat',
      historyItemKind: 'chat',
      historyItemId: 'conversation-1',
    }

    expect(buildActivityTabHref('account-1', filteredActivity, 'all', 'all')).toBe(
      '/w/support-abc123/activity?tab=all&filter=chat&itemKind=chat&itemId=conversation-1',
    )
    expect(buildActivityTabHref('account-1', filteredActivity, 'all', 'quality')).toBe('/w/support-abc123/quality')

    const filteredQuality: DashboardRouteState = {
      section: 'quality',
      workspacePublicRouteKey: 'support-abc123',
      qualityFeedback: ['down'],
      qualityTriageStates: ['open'],
    }

    expect(buildActivityTabHref('account-1', filteredQuality, 'quality', 'quality')).toBe(
      '/w/support-abc123/quality?feedback=down&triage=open',
    )
    expect(buildActivityTabHref('account-1', filteredQuality, 'quality', 'all')).toBe('/w/support-abc123/activity?tab=all')
  })

  it('ignores activity tab query state outside the activity section', () => {
    expect(parseDashboardRoute(['quality'], new URLSearchParams({
      tab: 'needs-attention',
      feedback: 'down',
    }))).toEqual({
      section: 'quality',
      qualityFeedback: ['down'],
    })
  })

  it('drops invalid section-specific parameters during parsing', () => {
    const params = new URLSearchParams({
      workspace: 'workspace-3',
      filter: 'invalid',
      page: '-10',
      tab: 'invalid',
      connector: 'connector-1',
    })

    expect(parseDashboardRoute(['activity'], params)).toEqual({
      section: 'activity',
      workspaceId: 'workspace-3',
    })
  })

  it('builds agent links with targeted channel anchor', () => {
    const href = buildDashboardHref('account-2', {
      section: 'agents',
      workspaceId: 'workspace-9',
      workspacePublicRouteKey: 'workspace-nine-abc123',
      agentTab: 'channels',
      anchor: 'website-embed',
    })

    expect(href).toBe('/w/workspace-nine-abc123/agents?tab=channels&anchor=website-embed')
  })

  it('maps the WhatsApp agent section to the channel anchor', () => {
    expect(agentSectionRoute('whatsapp-channel')).toEqual({
      agentTab: 'channels',
      anchor: 'whatsapp-channel',
    })
    expect(agentSectionFromRoute({
      agentTab: 'channels',
      anchor: 'whatsapp-channel',
    })).toBe('whatsapp-channel')
  })

  it('maps the directives agent section to the assistant directives anchor', () => {
    expect(agentSectionRoute('directives')).toEqual({
      agentTab: 'behavior',
      anchor: 'assistant-directives',
    })
    expect(agentSectionFromRoute({
      agentTab: 'behavior',
      anchor: 'assistant-directives',
    })).toBe('directives')
  })

  it('builds and parses agent routine editor routes', () => {
    const agentId = '67acb0c8-caad-4a1b-9fef-70cbca3f7d12'
    const routineId = '55555555-5555-4555-8555-000000000001'

    expect(buildDashboardHref('account-1', {
      section: 'agents',
      workspacePublicRouteKey: 'support-abc123',
      agentId,
      agentRoutineId: 'new',
    })).toBe(`/w/support-abc123/agents/${agentId}/routines/new`)

    expect(buildDashboardHref('account-1', {
      section: 'agents',
      workspacePublicRouteKey: 'support-abc123',
      agentId,
      agentRoutineId: routineId,
    })).toBe(`/w/support-abc123/agents/${agentId}/routines/${routineId}`)

    expect(parseDashboardRoute(['agents', agentId, 'routines', routineId], new URLSearchParams())).toEqual({
      section: 'agents',
      agentId,
      agentRoutineId: routineId,
    })
    expect(agentSectionFromRoute({ agentRoutineId: routineId })).toBe('routines')
    expect(parseDashboardRoute(['agents', agentId, 'routines', 'abc'], new URLSearchParams())).toBeNull()
  })

  it('parses only UUID agent path segments', () => {
    const agentId = '67acb0c8-caad-4a1b-9fef-70cbca3f7d12'

    expect(parseDashboardRoute(['agents', agentId], new URLSearchParams())).toEqual({
      section: 'agents',
      agentId,
    })

    expect(parseDashboardRoute(['agents'], new URLSearchParams())).toEqual({
      section: 'agents',
    })

    expect(parseDashboardRoute(['agents', 'current'], new URLSearchParams())).toBeNull()
    expect(parseDashboardRoute(['agents', 'abc'], new URLSearchParams())).toBeNull()
  })

  it('redirects legacy users routes into the account area', () => {
    expect(parseDashboardRoute(['settings'], new URLSearchParams({ workspace: 'workspace-5', tab: 'users' }))).toEqual({
      section: 'account',
      workspaceId: 'workspace-5',
    })

    expect(parseDashboardRoute(['users'], new URLSearchParams({ workspace: 'workspace-5' }))).toEqual({
      section: 'account',
      workspaceId: 'workspace-5',
    })

    expect(buildDashboardHref('account-7', {
      section: 'account',
      accountTab: 'usage',
      workspaceId: 'workspace-5',
      workspacePublicRouteKey: 'workspace-five-abc123',
    })).toBe('/w/workspace-five-abc123/account?tab=usage')
  })

  it('parses legacy routes into canonical route state', () => {
    expect(parseDashboardRoute(['chat'], new URLSearchParams({ workspace: 'workspace-1' }))).toEqual({
      section: 'agents',
      workspaceId: 'workspace-1',
    })

    expect(parseDashboardRoute(['documents', 'doc-1'], new URLSearchParams({ page: '2' }))).toEqual({
      section: 'knowledge',
      documentId: 'doc-1',
      documentsPage: 2,
    })

    expect(parseDashboardRoute(['history'], new URLSearchParams({ filter: 'chat' }))).toEqual({
      section: 'activity',
      historyFilter: 'chat',
    })

    expect(parseDashboardRoute(['users'], new URLSearchParams())).toEqual({
      section: 'account',
    })
  })

  it('parses legacy settings tabs into their new owners', () => {
    expect(parseDashboardRoute(['settings'], new URLSearchParams({
      tab: 'channels',
      anchor: 'website-embed',
    }))).toEqual({
      section: 'agents',
      agentTab: 'channels',
      anchor: 'website-embed',
    })

    expect(parseDashboardRoute(['settings'], new URLSearchParams({ tab: 'retrieval' }))).toEqual({
      section: 'settings',
    })
  })

  it('builds legacy account routes with an explicit workspace selection', () => {
    expect(buildAccountRoute('account-9', 'agents', undefined, 'workspace-12'))
      .toBe('/account/account-9/agents?workspace=workspace-12')
  })

  it('builds legacy dashboard hrefs explicitly when canonical workspace keys are unavailable', () => {
    expect(buildLegacyDashboardHref('account-4', {
      section: 'activity',
      workspaceId: 'workspace-4',
      historyFilter: 'search',
    })).toBe('/account/account-4/activity?workspace=workspace-4&filter=search')
  })

  it('retargets routes to another workspace without carrying workspace-scoped selections', () => {
    expect(retargetDashboardRouteToWorkspace({
      section: 'agents',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'workspace-one-abc123',
      agentId: '67acb0c8-caad-4a1b-9fef-70cbca3f7d12',
      agentTab: 'behavior',
      anchor: 'anonymous-chat',
    }, 'workspace-2', 'workspace-two-abc123')).toEqual({
      section: 'agents',
      workspaceId: 'workspace-2',
      workspacePublicRouteKey: 'workspace-two-abc123',
      agentTab: 'behavior',
    })

    expect(retargetDashboardRouteToWorkspace({
      section: 'knowledge',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'workspace-one-abc123',
      knowledgeTab: 'documents',
      documentId: 'doc-1',
      documentsPage: 3,
    }, 'workspace-2', 'workspace-two-abc123')).toEqual({
      section: 'knowledge',
      workspaceId: 'workspace-2',
      workspacePublicRouteKey: 'workspace-two-abc123',
    })
  })

  it('treats equivalent route states as equal even when they are rebuilt from fresh objects', () => {
    const parsed = parseDashboardRoute(['settings'], new URLSearchParams({
      workspace: 'workspace-9',
      tab: 'channels',
      anchor: 'website-embed',
    }))

    expect(parsed).not.toBeNull()

    const current = {
      ...parsed!,
      workspaceId: 'workspace-9',
      workspacePublicRouteKey: 'workspace-nine-abc123',
    }

    const next = {
      section: 'agents' as const,
      workspaceId: 'workspace-9',
      workspacePublicRouteKey: 'workspace-nine-abc123',
      agentTab: 'channels' as const,
      anchor: 'website-embed',
    }

    expect(areDashboardRouteStatesEqual(current, next)).toBe(true)
  })

  it('preserves quality triage filters in route state', () => {
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityFeedback: ['down'],
      qualityTriageStates: ['open', 'acknowledged'],
    })).toBe('/w/ws-key/quality?feedback=down&triage=open%2Cacknowledged')

    expect(parseDashboardRoute(['quality'], new URLSearchParams({
      feedback: 'down',
      triage: 'open,acknowledged,bogus',
    }))).toEqual({
      section: 'quality',
      qualityFeedback: ['down'],
      qualityTriageStates: ['open', 'acknowledged'],
    })
  })

  it('parses the eval list route', () => {
    const parsed = parseDashboardRoute(['eval'], new URLSearchParams())
    expect(parsed).toEqual({ section: 'eval' })
  })

  it('parses the eval case detail route', () => {
    const parsed = parseDashboardRoute(['eval', 'case-xyz'], new URLSearchParams())
    expect(parsed).toEqual({ section: 'eval', evalCaseId: 'case-xyz' })
  })

  it('builds eval list and detail hrefs with workspace key', () => {
    expect(buildDashboardHref('account-1', {
      section: 'eval',
      workspacePublicRouteKey: 'ws-key',
    })).toBe('/w/ws-key/eval')

    expect(buildDashboardHref('account-1', {
      section: 'eval',
      evalCaseId: 'case-xyz',
      workspacePublicRouteKey: 'ws-key',
    })).toBe('/w/ws-key/eval/case-xyz')
  })
})
