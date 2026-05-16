import { describe, expect, it, vi } from 'vitest'

import {
  getAgentCreationActionsConfigPath,
  parseAgentCreationActionDefinitions,
  resolveAgentCreationActions,
} from '@/lib/agent-creation-extensions'

describe('agent creation extensions', () => {
  it('parses valid generated action definitions', () => {
    expect(parseAgentCreationActionDefinitions({
      actions: [
        {
          id: 'website',
          label: 'Create from website',
          icon: 'globe',
          hrefTemplate: '/account/{accountId}/w/{workspacePublicRouteKey}/agent-wizard',
        },
        {
          id: 'invalid',
          label: 'Invalid',
          icon: 'sparkles',
          hrefTemplate: '/invalid',
        },
      ],
    })).toEqual([
      {
        id: 'website',
        label: 'Create from website',
        icon: 'globe',
        hrefTemplate: '/account/{accountId}/w/{workspacePublicRouteKey}/agent-wizard',
      },
    ])
  })

  it('resolves account and workspace placeholders into root-relative actions', () => {
    expect(resolveAgentCreationActions([
      {
        id: 'website',
        label: 'Create from website',
        icon: 'globe',
        hrefTemplate: '/account/{accountId}/w/{workspacePublicRouteKey}/agent-wizard',
      },
    ], {
      accountId: 'acct 1',
      workspacePublicRouteKey: 'site/key',
    })).toEqual([
      {
        id: 'website',
        label: 'Create from website',
        icon: 'globe',
        href: '/account/acct%201/w/site%2Fkey/agent-wizard',
        kind: 'route',
      },
    ])
  })

  it('resolves wizard-dialog actions without an href', () => {
    expect(resolveAgentCreationActions([
      {
        id: 'website',
        label: 'Create from website',
        icon: 'globe',
        kind: 'wizard-dialog',
      },
    ], {
      accountId: 'acct',
      workspacePublicRouteKey: 'key',
    })).toEqual([
      {
        id: 'website',
        label: 'Create from website',
        icon: 'globe',
        href: null,
        kind: 'wizard-dialog',
      },
    ])
  })

  it('keeps wizard-dialog actions visible even without a workspace public route key', () => {
    expect(resolveAgentCreationActions([
      {
        id: 'website',
        label: 'Create from website',
        icon: 'globe',
        kind: 'wizard-dialog',
      },
    ], {
      accountId: 'acct',
      workspacePublicRouteKey: null,
    })).toEqual([
      {
        id: 'website',
        label: 'Create from website',
        icon: 'globe',
        href: null,
        kind: 'wizard-dialog',
      },
    ])
  })

  it('resolves the generated action config under a configured app base path', () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/radioso/')
    try {
      expect(getAgentCreationActionsConfigPath()).toBe('/radioso/agent-creation-actions.json')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
