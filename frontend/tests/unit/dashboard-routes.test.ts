import { describe, expect, it } from 'vitest'

import { buildAccountRoute, buildDashboardHref, parseDashboardRoute } from '@/lib/dashboard-routes'

describe('dashboard route state', () => {
  it('builds a documents deep link with workspace and page state', () => {
    const href = buildDashboardHref('account-1', {
      section: 'documents',
      workspaceId: 'workspace-1',
      documentId: 'doc-9',
      documentsPage: 3,
    })

    expect(href).toBe('/account/account-1/documents/doc-9?workspace=workspace-1&page=3')
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

  it('builds settings links with targeted channel anchor', () => {
    const href = buildDashboardHref('account-2', {
      section: 'settings',
      workspaceId: 'workspace-9',
      settingsTab: 'channels',
      settingsAnchor: 'whatsapp-channel',
    })

    expect(href).toBe('/account/account-2/settings?workspace=workspace-9&tab=channels&anchor=whatsapp-channel')
  })

  it('parses and builds the users route without extra state', () => {
    expect(parseDashboardRoute(['users'], new URLSearchParams({ workspace: 'workspace-5' }))).toEqual({
      section: 'users',
      workspaceId: 'workspace-5',
    })

    expect(buildDashboardHref('account-7', {
      section: 'users',
      workspaceId: 'workspace-5',
    })).toBe('/account/account-7/users?workspace=workspace-5')
  })

  it('builds account routes with an explicit workspace selection', () => {
    expect(buildAccountRoute('account-9', 'chat', undefined, 'workspace-12'))
      .toBe('/account/account-9/chat?workspace=workspace-12')
  })
})
