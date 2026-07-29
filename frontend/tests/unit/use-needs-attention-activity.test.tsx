/* @vitest-environment jsdom */

import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNeedsAttentionActivity } from '@/hooks/use-needs-attention-activity'
import { chatApi, qualityApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import type { LowQualityTurn, PendingApprovalDecision, QualityActionFilter } from '@/lib/api'
import { inboxItemKeys, type HumanOwnedConversationSummary } from '@/lib/needs-attention'

const asDecisions = (decisions: unknown[]) => decisions as unknown as PendingApprovalDecision[]
const asConversations = (conversations: unknown[]) =>
  conversations as unknown as HumanOwnedConversationSummary[]

vi.mock('@/lib/api', () => ({
  chatApi: { listChatHistory: vi.fn() },
  qualityApi: { listTurns: vi.fn() },
}))

vi.mock('@/lib/api-hitl', () => ({
  hitlApi: { listPendingDecisions: vi.fn() },
}))

const chatApiMock = vi.mocked(chatApi)
const qualityApiMock = vi.mocked(qualityApi)
const hitlApiMock = vi.mocked(hitlApi)

const INTERVAL = 15000
const BACKGROUND_INTERVAL = 30000

const conversationSummary = (overrides: Record<string, unknown> = {}) => ({
  id: 'conversation-1',
  agentId: 'agent-1',
  agentName: 'Marta',
  sourceChannel: 'authenticated_chat',
  sourceOrigin: null,
  anonymousSessionId: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  updatedAt: '2026-06-19T10:00:00.000Z',
  messageCount: 1,
  userMessageCount: 1,
  assistantMessageCount: 0,
  preview: 'A guest needs manual follow-up',
  ownership: {
    conversationId: 'conversation-1',
    workspaceId: 'workspace-1',
    state: 'human_owned' as const,
    ownerAccountId: null,
    ownerDisplayName: null,
    reason: null,
    version: 1,
    takenOverAt: null,
    createdAt: '2026-06-19T10:00:00.000Z',
    updatedAt: '2026-06-19T10:00:00.000Z',
  },
  ...overrides,
})

const decisionSummary = (overrides: Record<string, unknown> = {}) => ({
  handle: 'decision-1',
  conversationId: 'conversation-1',
  agentId: 'agent-1',
  routineId: 'routine-1',
  stepId: 'step-1',
  reason: 'Approve sending the booking update',
  options: [{ id: 'approve', label: 'Approve' }],
  contentHash: 'hash-1',
  canResolve: true,
  deadline: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  ...overrides,
})

const qualityTurn = (overrides: Record<string, unknown> = {}) => ({
  assistantMessageId: 'quality-1',
  conversationId: 'quality-conversation-1',
  agentId: 'agent-1',
  agentName: 'Marta',
  channel: 'authenticated_chat',
  question: 'Can I change my booking?',
  answerPreview: 'I could not find that in the documents.',
  skillName: 'retrieval.answer',
  skillOutcome: 'no_context',
  skillStatus: 'completed',
  totalLatencyMs: 1200,
  createdAt: '2026-06-19T10:00:00.000Z',
  feedback: {
    upCount: 0,
    downCount: 0,
    latestDownUpdatedAt: null,
    comments: [],
  },
  triage: { state: 'open', reason: null, updatedAt: null },
  ...overrides,
})

const mockInbox = (decisions: unknown[], conversations: unknown[]) => {
  hitlApiMock.listPendingDecisions.mockResolvedValue({ decisions } as never)
  chatApiMock.listChatHistory.mockResolvedValue({
    conversations,
    total: conversations.length,
    nextCursor: null,
    hasMore: false,
  } as never)
}

const groundingActions: QualityActionFilter[] = [{ skillName: 'retrieval.answer', outcome: 'no_context' }]

let container: HTMLDivElement
let root: Root
const observed = { current: 0 }

function Probe({
  baselineKeys,
  enabled,
  qualityActions,
  onChange,
}: {
  baselineKeys: readonly string[] | null
  enabled: boolean
  qualityActions?: QualityActionFilter[]
  onChange: (newItemCount: number) => void
}) {
  const newItemCount = useNeedsAttentionActivity({
    baselineKeys,
    enabled,
    qualityActions,
    intervalMs: INTERVAL,
    backgroundIntervalMs: BACKGROUND_INTERVAL,
  })
  useEffect(() => {
    onChange(newItemCount)
  }, [newItemCount, onChange])
  return null
}

const renderProbe = (
  baselineKeys: readonly string[] | null,
  enabled = true,
  qualityActions?: QualityActionFilter[],
) => {
  act(() => {
    root.render(
      <Probe
        baselineKeys={baselineKeys}
        enabled={enabled}
        qualityActions={qualityActions}
        onChange={(value) => {
          observed.current = value
        }}
      />,
    )
  })
}

const advanceOnePoll = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(INTERVAL)
  })
}

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
}

const becomeHidden = () => {
  act(() => {
    setVisibility('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
  })
}

const becomeVisible = async () => {
  setVisibility('visible')
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
  })
}

beforeAll(() => {
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  qualityApiMock.listTurns.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 25,
    totalPages: 1,
  } as never)
  setVisibility('visible')
  observed.current = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('useNeedsAttentionActivity', () => {
  it('reports zero new items when the latest poll matches the displayed state', async () => {
    const decisions = [decisionSummary()]
    const conversations = [conversationSummary()]
    mockInbox(decisions, conversations)

    renderProbe(inboxItemKeys(asDecisions(decisions), asConversations(conversations), []))
    await advanceOnePoll()

    expect(observed.current).toBe(0)
    expect(chatApiMock.listChatHistory).toHaveBeenCalledWith({
      limit: 50,
      offset: 0,
      ownership: 'human_owned',
    })
  })

  it('counts fresh approvals that appear after the baseline', async () => {
    const conversations = [conversationSummary()]
    const baseline = inboxItemKeys(asDecisions([decisionSummary({ handle: 'decision-1' })]), asConversations(conversations), [])

    mockInbox(
      [
        decisionSummary({ handle: 'decision-1' }),
        decisionSummary({ handle: 'decision-2' }),
        decisionSummary({ handle: 'decision-3' }),
      ],
      conversations,
    )
    renderProbe(baseline)
    await advanceOnePoll()

    expect(observed.current).toBe(2)
  })

  it('does not poll when disabled', async () => {
    mockInbox([decisionSummary()], [conversationSummary()])
    renderProbe(null, false)
    await advanceOnePoll()

    expect(hitlApiMock.listPendingDecisions).not.toHaveBeenCalled()
    expect(observed.current).toBe(0)
  })

  it('keeps polling on a slower cadence while the document is hidden', async () => {
    mockInbox([decisionSummary()], [conversationSummary()])
    renderProbe(inboxItemKeys(asDecisions([decisionSummary()]), asConversations([conversationSummary()]), []))

    becomeHidden()

    // The foreground interval elapses with no poll — the background cadence is slower.
    await advanceOnePoll()
    expect(hitlApiMock.listPendingDecisions).not.toHaveBeenCalled()

    // Reaching the background interval triggers a poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BACKGROUND_INTERVAL - INTERVAL)
    })
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
  })

  it('polls immediately when the document becomes visible again', async () => {
    const conversations = [conversationSummary()]
    const baseline = inboxItemKeys(asDecisions([decisionSummary({ handle: 'decision-1' })]), asConversations(conversations), [])
    mockInbox([decisionSummary({ handle: 'decision-1' }), decisionSummary({ handle: 'decision-2' })], conversations)

    renderProbe(baseline)
    becomeHidden()
    await advanceOnePoll()
    expect(hitlApiMock.listPendingDecisions).not.toHaveBeenCalled()

    await becomeVisible()

    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
    expect(observed.current).toBe(1)
  })

  it('counts quality signals that arrive after the displayed baseline', async () => {
    const decisions = [decisionSummary()]
    const conversations = [conversationSummary()]
    const baselineQuality = [qualityTurn({ assistantMessageId: 'quality-1' })]
    mockInbox(decisions, conversations)
    qualityApiMock.listTurns.mockResolvedValue({
      items: [...baselineQuality, qualityTurn({
        assistantMessageId: 'quality-2',
        conversationId: 'quality-conversation-2',
      })],
      total: 2,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never)

    renderProbe(
      inboxItemKeys(asDecisions(decisions), asConversations(conversations), baselineQuality as LowQualityTurn[]),
      true,
      groundingActions,
    )
    await advanceOnePoll()

    expect(observed.current).toBe(1)
  })

  it('counts a newly added down-vote or comment as fresh activity', async () => {
    const baselineTurn = qualityTurn({
      feedback: {
        upCount: 0,
        downCount: 1,
        latestDownUpdatedAt: '2026-06-19T10:04:00.000Z',
        comments: [],
      },
    })
    const commentedTurn = qualityTurn({
      feedback: {
        upCount: 0,
        downCount: 1,
        latestDownUpdatedAt: '2026-06-19T10:05:00.000Z',
        comments: [{
          value: 'down',
          comment: 'The exception is missing.',
          createdAt: '2026-06-19T10:05:00.000Z',
          updatedAt: '2026-06-19T10:05:00.000Z',
        }],
      },
    })
    mockInbox([], [])
    qualityApiMock.listTurns.mockResolvedValue({
      items: [commentedTurn],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never)

    renderProbe(inboxItemKeys([], [], [baselineTurn] as LowQualityTurn[]))
    await advanceOnePoll()

    expect(observed.current).toBe(1)
  })

  it('clears stale polled keys when the displayed baseline changes', async () => {
    const decisions = [decisionSummary()]
    const conversations = [conversationSummary()]
    const displayedQuality = [qualityTurn({ assistantMessageId: 'quality-1' })]
    mockInbox(decisions, conversations)
    qualityApiMock.listTurns.mockResolvedValue({
      items: displayedQuality,
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never)

    renderProbe(
      inboxItemKeys(asDecisions(decisions), asConversations(conversations), displayedQuality as LowQualityTurn[]),
      true,
      groundingActions,
    )
    await advanceOnePoll()
    expect(observed.current).toBe(0)

    renderProbe(
      inboxItemKeys(asDecisions(decisions), asConversations(conversations), []),
      true,
      groundingActions,
    )

    expect(observed.current).toBe(0)
  })

  it('keeps escalation keys current when the quality poll fails', async () => {
    const conversations = [conversationSummary()]
    mockInbox([decisionSummary({ handle: 'decision-1' }), decisionSummary({ handle: 'decision-2' })], conversations)
    qualityApiMock.listTurns.mockRejectedValue(new Error('quality unavailable'))

    renderProbe(
      inboxItemKeys(asDecisions([decisionSummary({ handle: 'decision-1' })]), asConversations(conversations), []),
      true,
      groundingActions,
    )
    await advanceOnePoll()

    expect(observed.current).toBe(1)
  })

  it('keeps quality keys current when an escalation source fails', async () => {
    const conversations = [conversationSummary()]
    hitlApiMock.listPendingDecisions.mockRejectedValue(new Error('approvals unavailable'))
    chatApiMock.listChatHistory.mockResolvedValue({
      conversations,
      total: conversations.length,
      nextCursor: null,
      hasMore: false,
    } as never)
    qualityApiMock.listTurns.mockResolvedValue({
      items: [qualityTurn()],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never)

    renderProbe(inboxItemKeys([], asConversations(conversations), []), true, groundingActions)
    await advanceOnePoll()

    expect(observed.current).toBe(1)
  })

  it('continues polling negative feedback when grounding actions are unavailable', async () => {
    mockInbox([decisionSummary()], [conversationSummary()])
    qualityApiMock.listTurns.mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never)
    renderProbe(inboxItemKeys(asDecisions([decisionSummary()]), asConversations([conversationSummary()]), []))
    await advanceOnePoll()

    expect(qualityApiMock.listTurns).toHaveBeenCalledTimes(2)
    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(1, {
      feedback: ['down'],
      sort: 'negative_feedback_updated_at',
      activeNegativeFeedbackOnly: true,
      hasComment: true,
      limit: 25,
    })
    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(2, {
      feedback: ['down'],
      sort: 'negative_feedback_updated_at',
      activeNegativeFeedbackOnly: true,
      hasComment: false,
      limit: 25,
    })
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
    expect(chatApiMock.listChatHistory).toHaveBeenCalledTimes(1)
  })
})
