// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardQueryProvider } from '@/components/providers/dashboard-query-provider'
import { chatApi } from '@/lib/api-chat'
import { qualityApi } from '@/lib/api-quality'
import { hitlApi } from '@/lib/api-hitl'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import {
  NEEDS_ATTENTION_PAGE_SIZE,
  allAttentionSourcesTerminal,
  buildLatestAttentionSnapshot,
  needsAttentionQualityInputs,
  qualitySnapshotFromQueries,
  reconcileAttentionOperatorResult,
  refetchAttentionInboxSnapshot,
  refetchAttentionRailSnapshot,
  useAttentionRailQueries,
  useNeedsAttentionQueries,
} from '@/lib/needs-attention-query-state'
import { createEmptyQualityInboxSnapshot } from '@/lib/needs-attention-quality'
import { countNewInboxItems } from '@/lib/needs-attention'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-chat')>('@/lib/api-chat')
  return { ...actual, chatApi: { ...actual.chatApi, listChatHistory: vi.fn() } }
})
vi.mock('@/lib/api-quality', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-quality')>('@/lib/api-quality')
  return { ...actual, qualityApi: { ...actual.qualityApi, listTurns: vi.fn() } }
})
vi.mock('@/lib/api-hitl', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-hitl')>('@/lib/api-hitl')
  return { ...actual, hitlApi: { ...actual.hitlApi, listPendingDecisions: vi.fn() } }
})

const page = { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }
const renderProbe = async (onState: (value: unknown, client: QueryClient) => void) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const interest = {
    open: ({ onLifecycle }: { onLifecycle(signal: 'ready'): void }) => {
      onLifecycle('ready')
      return { close: vi.fn() }
    },
  } as never
  const Probe = () => {
    const queries = useNeedsAttentionQueries('workspace-1')
    const rail = useAttentionRailQueries('workspace-1')
    const client = useQueryClient()
    useEffect(() => { onState({ queries, rail }, client) }, [client, queries, rail])
    return null
  }
  await act(async () => {
    root.render(<DashboardQueryProvider workspaceId="workspace-1" interest={interest}><Probe /></DashboardQueryProvider>)
  })
  return { root, container }
}

afterEach(() => {
  vi.clearAllMocks()
  document.body.replaceChildren()
})

describe('Needs Attention query state', () => {
  it('uses the four exact variants and shares attention cache between view and rail', async () => {
    vi.mocked(hitlApi.listPendingDecisions).mockResolvedValue({ decisions: [] } as never)
    vi.mocked(chatApi.listChatHistory).mockResolvedValue({ conversations: [], total: 0 } as never)
    vi.mocked(qualityApi.listTurns).mockResolvedValue(page as never)
    let client!: QueryClient
    await renderProbe((_value, nextClient) => { client = nextClient })
    await vi.waitFor(() => {
      expect(hitlApi.listPendingDecisions).toHaveBeenCalledTimes(1)
      expect(chatApi.listChatHistory).toHaveBeenCalledTimes(1)
      expect(qualityApi.listTurns).toHaveBeenCalledTimes(2)
    })
    expect(hitlApi.listPendingDecisions).toHaveBeenCalledTimes(1)
    expect(chatApi.listChatHistory).toHaveBeenCalledWith({ limit: 50, offset: 0, ownership: 'human_owned' }, expect.any(AbortSignal))
    expect(client.getQueryData(dashboardQueryKeys.attention.decisions('workspace-1'))).toEqual({ decisions: [] })
    expect(client.getQueryData(dashboardQueryKeys.attention.humanOwned('workspace-1', { pageSize: NEEDS_ATTENTION_PAGE_SIZE }))).toEqual({ conversations: [], total: 0 })
    expect(qualityApi.listTurns).toHaveBeenNthCalledWith(1, expect.objectContaining({ feedback: ['down'], limit: 25, offset: 0 }), expect.any(AbortSignal))
    expect(qualityApi.listTurns).toHaveBeenNthCalledWith(2, expect.objectContaining({ signal: ['grounding_gaps', 'negative_feedback', 'skill_failures'], triageStates: ['acknowledged', 'open'], limit: 1, offset: 0 }), expect.any(AbortSignal))
  })

  it('forwards Query cancellation to every source', async () => {
    const pending = Promise.withResolvers<never>()
    vi.mocked(hitlApi.listPendingDecisions).mockReturnValue(pending.promise)
    vi.mocked(chatApi.listChatHistory).mockReturnValue(pending.promise)
    vi.mocked(qualityApi.listTurns).mockReturnValue(pending.promise)
    const { root, container } = await renderProbe(() => undefined)
    await vi.waitFor(() => {
      expect(hitlApi.listPendingDecisions).toHaveBeenCalled()
      expect(chatApi.listChatHistory).toHaveBeenCalled()
      expect(qualityApi.listTurns).toHaveBeenCalledTimes(2)
    })
    await act(async () => root.unmount())
    expect(vi.mocked(hitlApi.listPendingDecisions).mock.calls[0]?.[0]?.aborted).toBe(true)
    expect(vi.mocked(chatApi.listChatHistory).mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(vi.mocked(qualityApi.listTurns).mock.calls[0]?.[1]?.aborted).toBe(true)
    container.remove()
  })

  it('represents initial 403 as permission state while preserving other source data', () => {
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 })
    const snapshot = qualitySnapshotFromQueries(
      createEmptyQualityInboxSnapshot(),
      { status: 'error', error: forbidden },
      { status: 'success', error: null, data: { ...page, total: 4 } },
    )
    expect(snapshot.commentedFeedback.status).toBe('forbidden')
    expect(snapshot.reviewQueue.total).toBe(4)
  })

  it('does not bootstrap while hidden/not-ready and waits for all four terminal outcomes', () => {
    expect(allAttentionSourcesTerminal(false, ['success', 'success', 'success', 'success'])).toBe(false)
    expect(allAttentionSourcesTerminal(true, ['success', 'success', 'success', 'pending'])).toBe(false)
    expect(allAttentionSourcesTerminal(true, ['success', 'error', 'forbidden', 'success'])).toBe(true)
  })

  it('counts only latest keys absent from the full displayed snapshot', () => {
    expect(countNewInboxItems(['approval:one', 'conversation:one'], ['approval:one', 'conversation:one', 'approval:two'])).toBe(1)
  })

  it('reconciles only an authoritative AI handback by result conversation id', () => {
    const rows = [{ id: 'conversation-a' }, { id: 'conversation-b' }]
    expect(reconcileAttentionOperatorResult(rows, { kind: 'ownership', conversationId: 'conversation-a', ownershipState: 'human_owned' }))
      .toEqual(rows)
    expect(reconcileAttentionOperatorResult(rows, { kind: 'ownership', conversationId: 'conversation-a', ownershipState: 'ai_owned' }))
      .toEqual([{ id: 'conversation-b' }])
    expect(reconcileAttentionOperatorResult(rows, { kind: 'reply', conversationId: 'conversation-a' }))
      .toEqual(rows)
  })

  it('keeps the approved quality discriminators canonical', () => {
    expect(needsAttentionQualityInputs.commentedFeedback).toMatchObject({ feedback: ['down'], activeNegativeFeedbackOnly: true, hasComment: true, pageSize: 25 })
    expect(needsAttentionQualityInputs.reviewSummary).toMatchObject({ signal: ['negative_feedback', 'grounding_gaps', 'skill_failures'], triageStates: ['open', 'acknowledged'], pageSize: 1 })
  })

  it('builds the promoted composite from the current query results without mutating prior rows', () => {
    const previous = createEmptyQualityInboxSnapshot()
    const oldDecision = { handle: 'old' }
    const next = buildLatestAttentionSnapshot({
      previousQuality: previous,
      decisions: { decisions: [oldDecision] as never },
      humanOwned: { conversations: [] },
      commentedFeedback: { status: 'success', error: null, data: page },
      reviewSummary: { status: 'success', error: null, data: page },
    })
    expect(next.decisions).toEqual([oldDecision])
    expect(previous.commentedFeedback.turns).toEqual([])
  })

  it('promotes the results returned by a manual inbox refresh', async () => {
    const staleDecision = { handle: 'stale-decision' }
    const freshDecision = { handle: 'fresh-decision' }
    const staleConversation = { id: 'stale-conversation', ownership: { state: 'human_owned' } }
    const freshConversation = { id: 'fresh-conversation', ownership: { state: 'human_owned' } }

    const next = await refetchAttentionInboxSnapshot({
      previous: {
        decisions: [staleDecision] as never,
        humanOwnedConversations: [staleConversation] as never,
        qualitySnapshot: createEmptyQualityInboxSnapshot(),
      },
      decisions: {
        refetch: vi.fn().mockResolvedValue({
          status: 'success', error: null, data: { decisions: [freshDecision] },
        }),
      },
      humanOwned: {
        refetch: vi.fn().mockResolvedValue({
          status: 'success', error: null, data: { conversations: [freshConversation] },
        }),
      },
      commentedFeedback: {
        refetch: vi.fn().mockResolvedValue({
          status: 'success', error: null, data: { ...page, total: 3 },
        }),
      },
      reviewSummary: {
        refetch: vi.fn().mockResolvedValue({
          status: 'success', error: null, data: { ...page, total: 4 },
        }),
      },
    })

    expect(next.decisions).toEqual([freshDecision])
    expect(next.humanOwnedConversations).toEqual([freshConversation])
    expect(next.qualitySnapshot.commentedFeedback.total).toBe(3)
    expect(next.qualitySnapshot.reviewQueue.total).toBe(4)
  })

  it('promotes fresh rail rows after a drawer operator action', async () => {
    const freshDecision = { handle: 'fresh-decision' }
    const freshConversation = { id: 'fresh-conversation', ownership: { state: 'human_owned' } }

    const next = await refetchAttentionRailSnapshot({
      previous: {
        decisions: [{ handle: 'stale-decision' }] as never,
        humanOwnedConversations: [{ id: 'stale-conversation' }] as never,
      },
      decisions: {
        refetch: vi.fn().mockResolvedValue({
          status: 'success', error: null, data: { decisions: [freshDecision] },
        }),
      },
      humanOwned: {
        refetch: vi.fn().mockResolvedValue({
          status: 'success', error: null, data: { conversations: [freshConversation] },
        }),
      },
    })

    expect(next.decisions).toEqual([freshDecision])
    expect(next.humanOwnedConversations).toEqual([freshConversation])
  })

  it('reconciles operator results by result conversationId, never the currently selected row', async () => {
    const { reconcileAttentionOperatorResult } = await import('@/lib/needs-attention-query-state')
    const conversations = [{ id: 'conversation-a' }, { id: 'conversation-b' }]
    expect(reconcileAttentionOperatorResult(conversations, {
      kind: 'ownership', conversationId: 'conversation-a', ownershipState: 'human_owned',
    })).toEqual(conversations)
    expect(reconcileAttentionOperatorResult(conversations, {
      kind: 'ownership', conversationId: 'conversation-a', ownershipState: 'ai_owned',
    })).toEqual([{ id: 'conversation-b' }])
    expect(reconcileAttentionOperatorResult(conversations, {
      kind: 'reply', conversationId: 'conversation-a',
    })).toEqual(conversations)
    expect(reconcileAttentionOperatorResult(conversations, {
      kind: 'refresh', conversationId: 'conversation-a', reason: 'conflict',
    })).toEqual(conversations)
  })
})
