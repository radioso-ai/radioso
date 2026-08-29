import { describe, expect, it } from 'vitest'

import {
  areDashboardRouteStatesEqual,
  buildAccountRoute,
  buildDashboardHref,
  buildLegacyDashboardHref,
  DEFAULT_QUALITY_RANGE,
  type DashboardRouteState,
  parseDashboardRoute,
  retargetDashboardRouteToWorkspace,
} from '@/lib/dashboard-routes'
import { buildActivityTabHref, buildQualityTabHref } from '@/components/dashboard/activity-tabs'
import { QUALITY_SIGNAL_IDS, QUALITY_STATS_RANGES } from '@/lib/api-quality'
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

  it('round-trips Copilot page context selections without treating ids as URL text', () => {
    const agentId = '67acb0c8-caad-4a1b-9fef-70cbca3f7d12'
    const href = buildDashboardHref('account-1', {
      section: 'copilot',
      workspacePublicRouteKey: 'support-abc123',
      agentId,
      agentTab: 'chat',
      historyItemKind: 'chat',
      historyItemId: 'conversation-1',
    })

    expect(href).toBe('/w/support-abc123/copilot?tab=chat&agent=67acb0c8-caad-4a1b-9fef-70cbca3f7d12&itemKind=chat&itemId=conversation-1')
    expect(parseDashboardRoute(['copilot'], new URLSearchParams(href.split('?')[1]))).toEqual({
      section: 'copilot',
      agentId,
      agentTab: 'chat',
      historyItemKind: 'chat',
      historyItemId: 'conversation-1',
    })
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
    expect(buildActivityTabHref('account-1', filteredActivity, 'all', 'needs-attention')).toBe(
      '/w/support-abc123/activity',
    )
  })

  it('builds quality tab hrefs without discarding active surface filters', () => {
    const filteredQuality: DashboardRouteState = {
      section: 'quality',
      workspacePublicRouteKey: 'support-abc123',
      qualityFeedback: ['down'],
      qualityTriageStates: ['open'],
    }

    expect(buildQualityTabHref('account-1', filteredQuality, 'review', 'review')).toBe(
      '/w/support-abc123/quality?feedback=down&triage=open',
    )
    expect(buildQualityTabHref('account-1', filteredQuality, 'review', 'evals')).toBe('/w/support-abc123/eval')

    const filteredEval: DashboardRouteState = {
      section: 'eval',
      workspacePublicRouteKey: 'support-abc123',
      evalCaseId: 'case-xyz',
    }

    expect(buildQualityTabHref('account-1', filteredEval, 'evals', 'evals')).toBe(
      '/w/support-abc123/eval/case-xyz',
    )
    expect(buildQualityTabHref('account-1', filteredEval, 'evals', 'review')).toBe('/w/support-abc123/quality')
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

  it('preserves the agent chat conversation adoption parameter', () => {
    const agentId = '67acb0c8-caad-4a1b-9fef-70cbca3f7d12'
    const conversationId = '11111111-1111-4111-8111-111111111111'

    expect(buildDashboardHref('account-1', {
      section: 'agents',
      workspacePublicRouteKey: 'support-abc123',
      agentId,
      agentChatConversationId: conversationId,
    })).toBe(`/w/support-abc123/agents/${agentId}?chatConversation=${conversationId}`)

    expect(parseDashboardRoute(['agents', agentId], new URLSearchParams({
      chatConversation: conversationId,
    }))).toEqual({
      section: 'agents',
      agentId,
      agentChatConversationId: conversationId,
    })
  })

  it('round-trips a draft-routine test-chat link (chatPreviewRoutine)', () => {
    const agentId = '67acb0c8-caad-4a1b-9fef-70cbca3f7d12'
    const routineId = '22222222-2222-4222-8222-222222222222'

    expect(buildDashboardHref('account-1', {
      section: 'agents',
      workspacePublicRouteKey: 'support-abc123',
      agentId,
      agentChatPreviewRoutineId: routineId,
    })).toBe(`/w/support-abc123/agents/${agentId}?chatPreviewRoutine=${routineId}`)

    expect(parseDashboardRoute(['agents', agentId], new URLSearchParams({
      chatPreviewRoutine: routineId,
    }))).toEqual({
      section: 'agents',
      agentId,
      agentChatPreviewRoutineId: routineId,
    })
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

  it('round-trips detailed usage filters through the canonical account usage route', () => {
    const params = new URLSearchParams({
      tab: 'usage',
      usageFrom: '2026-06-01',
      usageTo: '2026-06-30',
      usageWorkspace: 'workspace-1',
    })

    expect(parseDashboardRoute(['account'], params)).toEqual({
      section: 'account',
      accountTab: 'usage',
      usageDetailsFrom: '2026-06-01',
      usageDetailsTo: '2026-06-30',
      usageDetailsWorkspaceId: 'workspace-1',
    })

    expect(buildDashboardHref('account-1', {
      ...parseDashboardRoute(['account'], params)!,
      workspacePublicRouteKey: 'workspace-key',
    })).toBe('/w/workspace-key/account?tab=usage&usageFrom=2026-06-01&usageTo=2026-06-30&usageWorkspace=workspace-1')
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

  it('retargets a quality route to another workspace while preserving the selected subview', () => {
    expect(retargetDashboardRouteToWorkspace({
      section: 'quality',
      workspaceId: 'workspace-1',
      workspacePublicRouteKey: 'workspace-one-abc123',
      qualityView: 'audience-pulse',
      qualityFeedback: ['down'],
    }, 'workspace-2', 'workspace-two-abc123')).toEqual({
      section: 'quality',
      workspaceId: 'workspace-2',
      workspacePublicRouteKey: 'workspace-two-abc123',
      qualityView: 'audience-pulse',
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

  it('preserves active negative-feedback queue semantics in quality links', () => {
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityFeedback: ['down'],
      qualitySort: 'negative_feedback_updated_at',
      qualityTriageStates: ['open', 'acknowledged'],
      qualityActiveNegativeFeedbackOnly: true,
    })).toBe(
      '/w/ws-key/quality?feedback=down&sort=negative_feedback_updated_at&triage=open%2Cacknowledged&activeNegativeFeedbackOnly=true',
    )

    expect(parseDashboardRoute(['quality'], new URLSearchParams({
      feedback: 'down',
      sort: 'negative_feedback_updated_at',
      triage: 'open,acknowledged',
      activeNegativeFeedbackOnly: 'true',
    }))).toEqual({
      section: 'quality',
      qualityFeedback: ['down'],
      qualitySort: 'negative_feedback_updated_at',
      qualityTriageStates: ['open', 'acknowledged'],
      qualityActiveNegativeFeedbackOnly: true,
    })
  })

  it('round-trips the health range, omitting the default window', () => {
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityRange: '7d',
    })).toBe('/w/ws-key/quality?range=7d')

    // 30d is the default, so it stays out of the URL.
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityRange: '30d',
    })).toBe('/w/ws-key/quality')

    expect(parseDashboardRoute(['quality'], new URLSearchParams({ range: '7d' }))).toEqual({
      section: 'quality',
      qualityRange: '7d',
    })
    expect(parseDashboardRoute(['quality'], new URLSearchParams({ range: '90d' }))).toEqual({
      section: 'quality',
    })
  })

  it('round-trips the queue signal preset independently of the health range', () => {
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualitySignal: 'grounding_gaps',
      qualityTriageStates: ['open', 'acknowledged'],
    })).toBe('/w/ws-key/quality?signal=grounding_gaps&triage=open%2Cacknowledged')

    expect(parseDashboardRoute(['quality'], new URLSearchParams({
      range: '7d',
      signal: 'skill_failures',
      triage: 'open',
    }))).toEqual({
      section: 'quality',
      qualityRange: '7d',
      qualitySignal: 'skill_failures',
      qualityTriageStates: ['open'],
    })

    expect(parseDashboardRoute(['quality'], new URLSearchParams({ signal: 'made_up' }))).toEqual({
      section: 'quality',
    })
  })

  it('round-trips normalized grounding evidence filters', () => {
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityGroundingVerdicts: ['degraded', 'no_support'],
      qualityHasUnsourcedClaims: true,
      qualityHasInvalidSources: true,
    })).toBe('/w/ws-key/quality?groundingVerdict=degraded%2Cno_support&hasUnsourcedClaims=true&hasInvalidSources=true')

    expect(parseDashboardRoute(['quality'], new URLSearchParams({
      groundingVerdict: 'degraded,unknown,no_support',
      hasUnsourcedClaims: 'true',
      hasInvalidSources: 'false',
    }))).toEqual({
      section: 'quality',
      qualityGroundingVerdicts: ['degraded', 'no_support'],
      qualityHasUnsourcedClaims: true,
    })
  })

  it('round-trips structured reasons and their terminal-transition window', () => {
    const state: DashboardRouteState = {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityResolutionReasons: ['knowledge_gap', 'out_of_scope'],
      qualityResolutionFrom: '2026-07-01T00:00:00.000Z',
      qualityResolutionTo: '2026-08-01T00:00:00.000Z',
      qualityTriageStates: ['resolved', 'dismissed'],
      qualityShowAll: true,
    }

    expect(buildDashboardHref('account-1', state)).toBe(
      '/w/ws-key/quality?triage=resolved%2Cdismissed&resolutionReason=knowledge_gap%2Cout_of_scope&resolutionFrom=2026-07-01T00%3A00%3A00.000Z&resolutionTo=2026-08-01T00%3A00%3A00.000Z&all=true',
    )

    expect(parseDashboardRoute(['quality'], new URLSearchParams({
      triage: 'resolved,dismissed',
      resolutionReason: 'knowledge_gap,bogus,out_of_scope',
      resolutionFrom: '2026-07-01T00:00:00.000Z',
      resolutionTo: 'not-a-date',
      all: 'true',
    }))).toEqual({
      section: 'quality',
      qualityTriageStates: ['resolved', 'dismissed'],
      qualityResolutionReasons: ['knowledge_gap', 'out_of_scope'],
      qualityResolutionFrom: '2026-07-01T00:00:00.000Z',
      qualityShowAll: true,
    })
  })

  it('round-trips the All answers escape hatch, omitting it when off', () => {
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityShowAll: true,
    })).toBe('/w/ws-key/quality?all=true')

    // Off is the default queue scope, so it never reaches the URL.
    expect(buildDashboardHref('account-1', {
      section: 'quality',
      workspacePublicRouteKey: 'ws-key',
      qualityShowAll: false,
    })).toBe('/w/ws-key/quality')

    expect(parseDashboardRoute(['quality'], new URLSearchParams({ all: 'true' }))).toEqual({
      section: 'quality',
      qualityShowAll: true,
    })
    expect(parseDashboardRoute(['quality'], new URLSearchParams({ all: 'false' }))).toEqual({
      section: 'quality',
    })
    expect(parseDashboardRoute(['quality'], new URLSearchParams({ all: 'yes' }))).toEqual({
      section: 'quality',
    })

    // It survives alongside the filters it is meant to widen.
    expect(parseDashboardRoute(['quality'], new URLSearchParams({
      all: 'true',
      feedback: 'down',
    }))).toEqual({
      section: 'quality',
      qualityShowAll: true,
      qualityFeedback: ['down'],
    })
  })

  // Route state and the fetch layer must speak one vocabulary. If the backend adds a
  // signal or a range, this fails until the URL parser accepts it too — otherwise a
  // valid link would be silently dropped on parse.
  it('parses every signal and range the API contract defines', () => {
    for (const signal of QUALITY_SIGNAL_IDS) {
      expect(
        parseDashboardRoute(['quality'], new URLSearchParams({ signal })),
      ).toEqual({ section: 'quality', qualitySignal: signal })
    }

    // The default range is normalised out of the URL, so assert the effective range
    // rather than its presence in the parsed state.
    for (const range of QUALITY_STATS_RANGES) {
      const parsed = parseDashboardRoute(['quality'], new URLSearchParams({ range }))
      expect(parsed).not.toBeNull()
      expect(parsed?.qualityRange ?? DEFAULT_QUALITY_RANGE).toBe(range)
    }
  })

  it('treats range and signal as distinguishing route state', () => {
    const base: DashboardRouteState = { section: 'quality', workspacePublicRouteKey: 'ws-key' }

    expect(areDashboardRouteStatesEqual(base, { ...base, qualityRange: '30d' })).toBe(true)
    expect(areDashboardRouteStatesEqual(base, { ...base, qualityRange: '7d' })).toBe(false)
    expect(areDashboardRouteStatesEqual(base, { ...base, qualitySignal: 'skill_failures' })).toBe(false)
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
