import { describe, expect, it } from 'vitest'

import { buildAccountRoute, buildDashboardHref, buildLegacyDashboardHref, parseDashboardRoute } from '@/lib/dashboard-routes'

describe('dashboard route state', () => {
  it('builds a canonical documents deep link with workspace key and page state', () => {
    const href = buildDashboardHref('account-1', {
      section: 'documents',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'support-abc123',
      documentId: 'doc-9',
      documentsPage: 3,
    })

    expect(href).toBe('/w/support-abc123/documents/doc-9?page=3')
  })

  it('parses history filter, page, and selected item state', () => {
    const params = new URLSearchParams({
      workspace: 'workspace-2',
      filter: 'search',
      page: '4',
      itemKind: 'search',
      itemId: 'search-77',
    })

    expect(parseDashboardRoute(['history'], params)).toEqual({
      section: 'history',
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

    expect(parseDashboardRoute(['history'], params)).toEqual({
      section: 'history',
      workspaceId: 'workspace-3',
    })
  })

  it('builds settings links with targeted anchor and connector selection', () => {
    const href = buildDashboardHref('account-2', {
      section: 'settings',
      workspaceId: 'workspace-9',
      workspacePublicRouteKey: 'workspace-nine-abc123',
      settingsTab: 'connectors',
      settingsAnchor: 'connectors',
      connectorId: 'whatsapp',
    })

    expect(href).toBe('/w/workspace-nine-abc123/settings?tab=connectors&anchor=connectors&connector=whatsapp')
  })

  it('parses and builds the users route without extra state', () => {
    expect(parseDashboardRoute(['users'], new URLSearchParams({ workspace: 'workspace-5' }))).toEqual({
      section: 'users',
      workspaceId: 'workspace-5',
    })

    expect(buildDashboardHref('account-7', {
      section: 'users',
      workspaceId: 'workspace-5',
      workspacePublicRouteKey: 'workspace-five-abc123',
    })).toBe('/w/workspace-five-abc123/users')
  })

  it('builds legacy account routes with an explicit workspace selection', () => {
    expect(buildAccountRoute('account-9', 'chat', undefined, 'workspace-12'))
      .toBe('/account/account-9/chat?workspace=workspace-12')
  })

  it('builds legacy dashboard hrefs explicitly when canonical workspace keys are unavailable', () => {
    expect(buildLegacyDashboardHref('account-4', {
      section: 'history',
      workspaceId: 'workspace-4',
      historyFilter: 'search',
    })).toBe('/account/account-4/history?workspace=workspace-4&filter=search')
  })
})
