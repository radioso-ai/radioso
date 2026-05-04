import { describe, expect, it } from 'vitest'

import {
  areDashboardRouteStatesEqual,
  buildAccountRoute,
  buildDashboardHref,
  buildLegacyDashboardHref,
  parseDashboardRoute,
} from '@/lib/dashboard-routes'

describe('dashboard route state', () => {
  it('builds a canonical agent route with workspace key and selected tab state', () => {
    const href = buildDashboardHref('account-1', {
      section: 'agents',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'support-abc123',
      agentTab: 'behavior',
    })

    expect(href).toBe('/w/support-abc123/agents/current?tab=behavior')
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

    expect(href).toBe('/w/workspace-nine-abc123/agents/current?tab=channels&anchor=website-embed')
  })

  it('parses and builds the users tab route without extra state', () => {
    expect(parseDashboardRoute(['settings'], new URLSearchParams({ workspace: 'workspace-5', tab: 'users' }))).toEqual({
      section: 'settings',
      workspaceId: 'workspace-5',
      settingsTab: 'users',
    })

    expect(buildDashboardHref('account-7', {
      section: 'settings',
      settingsTab: 'users',
      workspaceId: 'workspace-5',
      workspacePublicRouteKey: 'workspace-five-abc123',
    })).toBe('/w/workspace-five-abc123/settings?tab=users')
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
      section: 'settings',
      settingsTab: 'users',
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
      section: 'knowledge',
      knowledgeTab: 'retrieval',
    })
  })

  it('builds legacy account routes with an explicit workspace selection', () => {
    expect(buildAccountRoute('account-9', 'agents', undefined, 'workspace-12'))
      .toBe('/account/account-9/agents/current?workspace=workspace-12')
  })

  it('builds legacy dashboard hrefs explicitly when canonical workspace keys are unavailable', () => {
    expect(buildLegacyDashboardHref('account-4', {
      section: 'activity',
      workspaceId: 'workspace-4',
      historyFilter: 'search',
    })).toBe('/account/account-4/activity?workspace=workspace-4&filter=search')
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
})
