// @vitest-environment jsdom

import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, useQueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DashboardQueryProvider } from '@/components/providers/dashboard-query-provider'
import { chatApi } from '@/lib/api-chat'
import { qualityApi } from '@/lib/api-quality'
import { hitlApi } from '@/lib/api-hitl'
import { replyReviewApi } from '@/lib/api-reply-review'
import { dashboardQueryKeys } from '@/lib/dashboard-query-keys'
import {
  NEEDS_ATTENTION_PAGE_SIZE,
  allAttentionSourcesTerminal,
  buildLatestAttentionSnapshot,
  createRequestQueue,
  flattenAttentionChunks,
  needsAttentionQualityInputs,
  qualityLoadStateFromQueries,
  qualitySnapshotFromQueries,
  reconcileAttentionOperatorResult,
  refetchAttentionInboxSnapshot,
  refetchAttentionRailSnapshot,
  readAllCursorPages,
  useAttentionRailQueries,
  useConversationSources,
  useNeedsAttentionOpenCount,
  useNeedsAttentionQueries,
  withoutAttentionItem,
} from '@/lib/needs-attention-query-state'
import { createEmptyQualityInboxSnapshot } from '@/lib/needs-attention-quality'
import { countNewInboxItems } from '@/lib/needs-attention'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api-chat', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-chat')>('@/lib/api-chat')
  return { ...actual, chatApi: { ...actual.chatApi, listChatHistory: vi.fn(), getHistoryConversation: vi.fn() } }
})
vi.mock('@/lib/api-quality', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-quality')>('@/lib/api-quality')
  return { ...actual, qualityApi: { ...actual.qualityApi, listTurns: vi.fn() } }
})
vi.mock('@/lib/api-hitl', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-hitl')>('@/lib/api-hitl')
  return { ...actual, hitlApi: { ...actual.hitlApi, listPendingDecisions: vi.fn() } }
})
vi.mock('@/lib/api-reply-review', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-reply-review')>('@/lib/api-reply-review')
  return { ...actual, replyReviewApi: { ...actual.replyReviewApi, listDeliveryFailures: vi.fn(), listHeldReplies: vi.fn() } }
})

const page = { items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 }
const noDeliveryFailures = { items: [], nextCursor: null }
const noHeldReplies = { items: [], nextCursor: null }
const heldReply = (id: string, conversationId: string) => ({
  id,
  conversationId,
  agentId: 'agent-1',
  state: 'pending' as const,
  holdReason: 'draft_mode',
  facts: { grounding: 'grounded', coverage: 'answered', handoff: { requested: false, reason: null }, outcome: 'answered' },
  dependsOnSuppressedAction: false,
  suppressedEffects: [],
  draftText: 'Your order shipped on Monday.',
  editedText: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  decidedAt: null,
  releaserUserId: null,
  editorUserId: null,
  attentionOpen: true,
  trace: null,
})
const interest = {
  open: ({ onLifecycle }: { onLifecycle(signal: 'ready'): void }) => {
    onLifecycle('ready')
    return { close: vi.fn() }
  },
} as never
const renderProbe = async (onState: (value: unknown, client: QueryClient) => void) => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
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
  it('uses the exact variants and shares attention cache between view and rail', async () => {
    vi.mocked(hitlApi.listPendingDecisions).mockResolvedValue({ decisions: [] })
    vi.mocked(chatApi.listChatHistory).mockResolvedValue({ conversations: [], total: 0 } as never)
    vi.mocked(qualityApi.listTurns).mockResolvedValue(page)
    vi.mocked(replyReviewApi.listDeliveryFailures).mockResolvedValue(noDeliveryFailures)
    vi.mocked(replyReviewApi.listHeldReplies).mockResolvedValue(noHeldReplies)
    let client!: QueryClient
    await renderProbe((_value, nextClient) => { client = nextClient })
    await vi.waitFor(() => {
      expect(hitlApi.listPendingDecisions).toHaveBeenCalledTimes(1)
      expect(chatApi.listChatHistory).toHaveBeenCalledTimes(1)
      expect(qualityApi.listTurns).toHaveBeenCalledTimes(2)
      expect(replyReviewApi.listDeliveryFailures).toHaveBeenCalledTimes(1)
      expect(replyReviewApi.listHeldReplies).toHaveBeenCalledTimes(1)
    })
    // Held replies are a second approval source, read beside routine decisions, never instead of them.
    expect(replyReviewApi.listHeldReplies).toHaveBeenCalledWith({ attention: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE }, expect.any(AbortSignal))
    expect(client.getQueryData(dashboardQueryKeys.attention.heldReplies('workspace-1', { limit: NEEDS_ATTENTION_PAGE_SIZE })))
      .toEqual({ pages: [noHeldReplies], pageParams: [null] })
    expect(replyReviewApi.listDeliveryFailures).toHaveBeenCalledWith({ state: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE }, expect.any(AbortSignal))
    expect(client.getQueryData(dashboardQueryKeys.attention.deliveryFailures('workspace-1', { limit: NEEDS_ATTENTION_PAGE_SIZE })))
      .toEqual({ pages: [noDeliveryFailures], pageParams: [null] })
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
    vi.mocked(replyReviewApi.listDeliveryFailures).mockReturnValue(pending.promise)
    vi.mocked(replyReviewApi.listHeldReplies).mockReturnValue(pending.promise)
    const { root, container } = await renderProbe(() => undefined)
    await vi.waitFor(() => {
      expect(hitlApi.listPendingDecisions).toHaveBeenCalled()
      expect(chatApi.listChatHistory).toHaveBeenCalled()
      expect(qualityApi.listTurns).toHaveBeenCalledTimes(2)
      expect(replyReviewApi.listDeliveryFailures).toHaveBeenCalled()
      expect(replyReviewApi.listHeldReplies).toHaveBeenCalled()
    })
    await act(async () => root.unmount())
    expect(vi.mocked(hitlApi.listPendingDecisions).mock.calls[0]?.[0]?.aborted).toBe(true)
    expect(vi.mocked(replyReviewApi.listDeliveryFailures).mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(vi.mocked(replyReviewApi.listHeldReplies).mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(vi.mocked(chatApi.listChatHistory).mock.calls[0]?.[1]?.aborted).toBe(true)
    expect(vi.mocked(qualityApi.listTurns).mock.calls[0]?.[1]?.aborted).toBe(true)
    container.remove()
  })

  it('counts open delivery failures in the Needs-you lens', async () => {
    vi.mocked(hitlApi.listPendingDecisions).mockResolvedValue({ decisions: [] })
    vi.mocked(chatApi.listChatHistory).mockResolvedValue({ conversations: [], total: 0 } as never)
    vi.mocked(qualityApi.listTurns).mockResolvedValue(page)
    vi.mocked(replyReviewApi.listHeldReplies).mockResolvedValue(noHeldReplies)
    vi.mocked(replyReviewApi.listDeliveryFailures).mockResolvedValue({
      items: ['failure-1', 'failure-2'].map((id) => ({
        id,
        conversationId: `conversation-${id}`,
        messageId: `message-${id}`,
        provider: 'email',
        kind: 'bounced' as const,
        detailCode: 'mailbox_full',
        openedAt: '2026-06-19T10:00:00.000Z',
        clearedAt: null,
        clearReason: null,
      })),
      nextCursor: null,
    })
    const counts: number[] = []
    const Count = () => {
      const count = useNeedsAttentionOpenCount('workspace-1')
      useEffect(() => { counts.push(count) }, [count])
      return null
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<DashboardQueryProvider workspaceId="workspace-1" interest={interest}><Count /></DashboardQueryProvider>)
    })
    await vi.waitFor(() => expect(counts.at(-1)).toBe(2))
    await act(async () => root.unmount())
  })

  it('counts held replies as approvals beside routine approvals in the Needs-you lens', async () => {
    vi.mocked(hitlApi.listPendingDecisions).mockResolvedValue({
      decisions: [{
        handle: 'decision-1',
        conversationId: 'conversation-routine',
        agentId: 'agent-1',
        routineId: 'routine-1',
        stepId: 'step-1',
        reason: 'Approve the refund',
        options: [{ id: 'approve', label: 'Approve' }],
        contentHash: 'hash-1',
        canResolve: true,
        deadline: null,
        createdAt: '2026-06-19T09:00:00.000Z',
      }],
    })
    vi.mocked(chatApi.listChatHistory).mockResolvedValue({ conversations: [], total: 0 } as never)
    vi.mocked(qualityApi.listTurns).mockResolvedValue(page)
    vi.mocked(replyReviewApi.listDeliveryFailures).mockResolvedValue(noDeliveryFailures)
    vi.mocked(replyReviewApi.listHeldReplies).mockResolvedValue({
      items: [heldReply('held-1', 'conversation-email-1'), heldReply('held-2', 'conversation-email-2')],
      nextCursor: null,
    })
    const counts: number[] = []
    const Count = () => {
      const count = useNeedsAttentionOpenCount('workspace-1')
      useEffect(() => { counts.push(count) }, [count])
      return null
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<DashboardQueryProvider workspaceId="workspace-1" interest={interest}><Count /></DashboardQueryProvider>)
    })
    await vi.waitFor(() => expect(counts.at(-1)).toBe(3))
    await act(async () => root.unmount())
  })

  it('reads every page of held replies and delivery failures, so the oldest beyond the first page still counts', async () => {
    vi.mocked(hitlApi.listPendingDecisions).mockResolvedValue({ decisions: [] })
    vi.mocked(chatApi.listChatHistory).mockResolvedValue({ conversations: [], total: 0 } as never)
    vi.mocked(qualityApi.listTurns).mockResolvedValue(page)
    const heldReplies = Array.from({ length: NEEDS_ATTENTION_PAGE_SIZE + 1 }, (_, index) =>
      heldReply(`held-${index}`, `conversation-held-${index}`))
    vi.mocked(replyReviewApi.listHeldReplies).mockImplementation(async (query) => query?.cursor === 'held-page-2'
      ? { items: heldReplies.slice(NEEDS_ATTENTION_PAGE_SIZE), nextCursor: null }
      : { items: heldReplies.slice(0, NEEDS_ATTENTION_PAGE_SIZE), nextCursor: 'held-page-2' })
    const failure = (id: string) => ({
      id,
      conversationId: `conversation-${id}`,
      messageId: `message-${id}`,
      provider: 'email',
      kind: 'bounced' as const,
      detailCode: null,
      openedAt: '2026-06-19T10:00:00.000Z',
      clearedAt: null,
      clearReason: null,
    })
    vi.mocked(replyReviewApi.listDeliveryFailures).mockImplementation(async (query) => query?.cursor === 'failure-page-2'
      ? { items: [failure('failure-oldest')], nextCursor: null }
      : { items: [failure('failure-newest')], nextCursor: 'failure-page-2' })

    const counts: number[] = []
    const Count = () => {
      const count = useNeedsAttentionOpenCount('workspace-1')
      useEffect(() => { counts.push(count) }, [count])
      return null
    }
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<DashboardQueryProvider workspaceId="workspace-1" interest={interest}><Count /></DashboardQueryProvider>)
    })
    await vi.waitFor(() => expect(counts.at(-1)).toBe(NEEDS_ATTENTION_PAGE_SIZE + 1 + 2))
    expect(replyReviewApi.listHeldReplies).toHaveBeenCalledWith({ attention: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE }, expect.any(AbortSignal))
    expect(replyReviewApi.listHeldReplies).toHaveBeenCalledWith(
      { attention: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE, cursor: 'held-page-2' },
      expect.any(AbortSignal),
    )
    expect(replyReviewApi.listDeliveryFailures).toHaveBeenCalledWith(
      { state: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE, cursor: 'failure-page-2' },
      expect.any(AbortSignal),
    )
    await act(async () => root.unmount())
  })

  it('stops a long source at its read limit, and loading older reads on from where it stopped until the oldest', async () => {
    vi.mocked(hitlApi.listPendingDecisions).mockResolvedValue({ decisions: [] })
    vi.mocked(chatApi.listChatHistory).mockResolvedValue({ conversations: [], total: 0 } as never)
    vi.mocked(qualityApi.listTurns).mockResolvedValue(page)
    vi.mocked(replyReviewApi.listDeliveryFailures).mockResolvedValue(noDeliveryFailures)
    // One draft to a page, so the twenty pages one read follows end a draft short of the oldest.
    const drafts = Array.from({ length: 21 }, (_, index) => heldReply(`held-${index}`, `conversation-held-${index}`))
    vi.mocked(replyReviewApi.listHeldReplies).mockImplementation(async (query) => {
      const index = query?.cursor ? Number(query.cursor.replace('page-', '')) : 0
      return { items: [drafts[index]], nextCursor: index < drafts.length - 1 ? `page-${index + 1}` : null }
    })
    type RailState = { rail: ReturnType<typeof useAttentionRailQueries> }
    let latest: RailState | null = null
    const { root } = await renderProbe((value) => { latest = value as RailState })
    const rail = () => latest!.rail

    await vi.waitFor(() => expect(rail().heldReplies.data?.items).toHaveLength(20))
    expect(rail().heldReplies.data?.nextCursor).toBe('page-20')
    expect(rail().olderAttention).toMatchObject({ available: true, loading: false })

    await act(async () => rail().olderAttention.load())
    await vi.waitFor(() => expect(rail().heldReplies.data?.items).toHaveLength(21))
    expect(rail().heldReplies.data?.items.at(-1)?.id).toBe('held-20')
    expect(rail().heldReplies.data?.nextCursor).toBeNull()
    expect(rail().olderAttention).toMatchObject({ available: false, loading: false })
    expect(replyReviewApi.listHeldReplies).toHaveBeenCalledWith(
      { attention: 'open', limit: NEEDS_ATTENTION_PAGE_SIZE, cursor: 'page-20' },
      expect.any(AbortSignal),
    )
    // The failures had nothing older, so loading older read nothing more of them.
    expect(replyReviewApi.listDeliveryFailures).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('looks up the conversations of delivery failures the Inbox has not loaded, once each, by id', async () => {
    vi.mocked(chatApi.getHistoryConversation).mockImplementation(async (conversationId) => ({
      conversationId,
      title: `Title of ${conversationId}`,
      updatedAt: '2026-06-19T10:00:00.000Z',
      agentId: 'agent-email',
      agentName: 'Gioia',
      agentInternalName: null,
      ownership: undefined,
    }) as never)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const seen: unknown[] = []
    const Probe = () => {
      const sources = useConversationSources('workspace-1', ['conversation-a', 'conversation-b'])
      useEffect(() => { seen.push(sources) }, [sources])
      return null
    }
    await act(async () => {
      root.render(<DashboardQueryProvider workspaceId="workspace-1" interest={interest}><Probe /></DashboardQueryProvider>)
    })
    await vi.waitFor(() => expect(seen.at(-1)).toHaveLength(2))
    expect(seen.at(-1)).toEqual([
      expect.objectContaining({ id: 'conversation-a', agentId: 'agent-email', title: 'Title of conversation-a' }),
      expect.objectContaining({ id: 'conversation-b', agentId: 'agent-email', title: 'Title of conversation-b' }),
    ])
    expect(chatApi.getHistoryConversation).toHaveBeenCalledTimes(2)
    expect(chatApi.getHistoryConversation).toHaveBeenCalledWith('conversation-a', { limit: 1 }, expect.any(AbortSignal))
    await act(async () => root.unmount())
  })

  it('reads conversation lookups once, never on the dashboard poll, and a few at a time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const pending: { conversationId: string; resolve: (value: unknown) => void }[] = []
      vi.mocked(chatApi.getHistoryConversation).mockImplementation((conversationId) => new Promise((resolve) => {
        pending.push({ conversationId, resolve })
      }) as never)
      const ids = Array.from({ length: 10 }, (_, index) => `conversation-${index}`)
      const seen: unknown[][] = []
      const Probe = () => {
        const sources = useConversationSources('workspace-1', ids)
        useEffect(() => { seen.push(sources) }, [sources])
        return null
      }
      const container = document.createElement('div')
      document.body.append(container)
      const root = createRoot(container)
      await act(async () => {
        root.render(<DashboardQueryProvider workspaceId="workspace-1" interest={interest}><Probe /></DashboardQueryProvider>)
      })

      await vi.waitFor(() => expect(chatApi.getHistoryConversation).toHaveBeenCalledTimes(4))
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(chatApi.getHistoryConversation).toHaveBeenCalledTimes(4)

      // Settles the reads in flight now; the ones they let start wait for the next call.
      const settle = async () => {
        const inFlight = pending.splice(0)
        await act(async () => {
          for (const read of inFlight) {
            read.resolve({ conversationId: read.conversationId, title: read.conversationId, updatedAt: '2026-06-19T10:00:00.000Z', agentId: 'agent-email' })
          }
        })
      }
      await settle()
      await vi.waitFor(() => expect(chatApi.getHistoryConversation).toHaveBeenCalledTimes(8))
      await settle()
      await vi.waitFor(() => expect(chatApi.getHistoryConversation).toHaveBeenCalledTimes(10))
      await settle()
      await vi.waitFor(() => expect(seen.at(-1)).toHaveLength(10))

      // Well past every dashboard poll interval, nothing is read again.
      await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60_000) })
      expect(chatApi.getHistoryConversation).toHaveBeenCalledTimes(10)
      await act(async () => root.unmount())
    } finally {
      vi.useRealTimers()
    }
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

  it('reads the quality load state off the queries themselves, not the promoted snapshot', () => {
    // The snapshot promotes on a microtask, so a consumer that must not act on a
    // stale reading has to read the queries directly.
    const forbidden = Object.assign(new Error('forbidden'), { status: 403 })
    expect(qualityLoadStateFromQueries({ status: 'error', error: forbidden }, { status: 'pending', error: null }))
      .toEqual({ permissionDenied: true, hasLoadFailure: false })
    expect(qualityLoadStateFromQueries({ status: 'error', error: new Error('boom') }, { status: 'success', error: null, data: page }))
      .toEqual({ permissionDenied: false, hasLoadFailure: true })
    expect(qualityLoadStateFromQueries({ status: 'success', error: null, data: page }, { status: 'pending', error: null }))
      .toEqual({ permissionDenied: false, hasLoadFailure: false })
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

describe('readAllCursorPages', () => {
  const pageOf = (ids: string[], nextCursor: string | null) => ({ items: ids.map((id) => ({ id })), nextCursor })

  it('follows each next cursor until the list ends', async () => {
    const readPage = vi.fn(async (cursor: string | null) =>
      cursor === null ? pageOf(['a', 'b'], 'c2') : cursor === 'c2' ? pageOf(['c'], 'c3') : pageOf(['d'], null))

    await expect(readAllCursorPages(readPage)).resolves.toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }], nextCursor: null })
    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, 'c2', 'c3'])
  })

  it('keeps one of an item a moving list returns on two pages', async () => {
    const readPage = async (cursor: string | null) => cursor === null ? pageOf(['a', 'b'], 'c2') : pageOf(['b', 'c'], null)

    await expect(readAllCursorPages(readPage)).resolves.toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextCursor: null })
  })

  it('stops after the page limit and returns where the unread rest starts', async () => {
    const readPage = vi.fn(async (cursor: string | null) => pageOf([cursor ?? 'first'], `${cursor ?? 'first'}+`))

    await expect(readAllCursorPages(readPage, 2)).resolves.toEqual({ items: [{ id: 'first' }, { id: 'first+' }], nextCursor: 'first++' })
    expect(readPage).toHaveBeenCalledTimes(2)
  })
})

describe('attention source chunks', () => {
  const pageOf = (ids: string[], nextCursor: string | null) => ({ items: ids.map((id) => ({ id })), nextCursor })

  it('starts a read where an earlier one stopped', async () => {
    const readPage = vi.fn(async (cursor: string | null) => cursor === 'c3' ? pageOf(['c'], 'c4') : pageOf(['d'], null))

    await expect(readAllCursorPages(readPage, 20, 'c3')).resolves.toEqual({ items: [{ id: 'c' }, { id: 'd' }], nextCursor: null })
    expect(readPage.mock.calls.map(([cursor]) => cursor)).toEqual(['c3', 'c4'])
  })

  it('reads every chunk as one newest-first list, each item once, with where the unread rest starts', () => {
    expect(flattenAttentionChunks({
      pages: [pageOf(['a', 'b'], 'c3'), pageOf(['b', 'c'], 'c5')],
      pageParams: [null, 'c3'],
    })).toEqual({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], nextCursor: 'c5' })
    expect(flattenAttentionChunks({
      pages: [pageOf(['a'], 'c2'), pageOf(['b'], null)],
      pageParams: [null, 'c2'],
    })).toEqual({ items: [{ id: 'a' }, { id: 'b' }], nextCursor: null })
  })

  it('drops a settled item from whichever chunk holds it, keeping each chunk\'s cursor', () => {
    expect(withoutAttentionItem({
      pages: [pageOf(['a', 'b'], 'c3'), pageOf(['c'], null)],
      pageParams: [null, 'c3'],
    }, 'c')).toEqual({ pages: [pageOf(['a', 'b'], 'c3'), pageOf([], null)], pageParams: [null, 'c3'] })
    expect(withoutAttentionItem(undefined, 'a')).toBeUndefined()
  })
})

describe('createRequestQueue', () => {
  it('runs a few reads at once and starts the next as one settles', async () => {
    const enqueue = createRequestQueue(2)
    const reads = Array.from({ length: 3 }, () => Promise.withResolvers<string>())
    const started: number[] = []
    const results = reads.map((read, index) => enqueue(() => {
      started.push(index)
      return read.promise
    }))
    expect(started).toEqual([0, 1])

    reads[0].resolve('first')
    await expect(results[0]).resolves.toBe('first')
    expect(started).toEqual([0, 1, 2])
    reads[1].reject(new Error('boom'))
    await expect(results[1]).rejects.toThrow('boom')
    reads[2].resolve('third')
    await expect(results[2]).resolves.toBe('third')
  })

  it('never starts a read cancelled while it waited', async () => {
    const enqueue = createRequestQueue(1)
    const first = Promise.withResolvers<string>()
    const controller = new AbortController()
    const waiting = vi.fn(async () => 'never')
    void enqueue(() => first.promise)
    const cancelled = enqueue(waiting, controller.signal)
    const after = vi.fn(async () => 'after')
    const next = enqueue(after)

    controller.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    first.resolve('first')
    await expect(next).resolves.toBe('after')
    expect(waiting).not.toHaveBeenCalled()
  })
})
