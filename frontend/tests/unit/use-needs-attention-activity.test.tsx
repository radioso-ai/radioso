/* @vitest-environment jsdom */

import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNeedsAttentionActivity } from '@/hooks/use-needs-attention-activity'
import { chatApi, qualityApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import type { LowQualityTurn, PendingApprovalDecision } from '@/lib/api'
import { inboxItemKeys, type HumanOwnedConversationSummary } from '@/lib/needs-attention'
import { useWorkspaceEventsOptional } from '@/lib/workspace-events-context'

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

vi.mock('@/lib/workspace-events-context', () => ({
  useWorkspaceEventsOptional: vi.fn(),
}))

const chatApiMock = vi.mocked(chatApi)
const qualityApiMock = vi.mocked(qualityApi)
const hitlApiMock = vi.mocked(hitlApi)
const useWorkspaceEventsOptionalMock = vi.mocked(useWorkspaceEventsOptional)

const INTERVAL = 15000
const BACKGROUND_INTERVAL = 30000

const conversationSummary = (overrides: Record<string, unknown> = {}) => ({
  id: 'conversation-1',
  agentId: 'agent-1',
  agentName: 'Marta',
  agentInternalName: null,
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
  agentInternalName: null,
  channel: 'authenticated_chat',
  question: 'Can I change my booking?',
  answerPreview: 'I could not find that in the documents.',
  skillName: 'retrieval.answer',
  skillOutcome: 'no_context',
  skillStatus: 'completed',
  totalLatencyMs: 1200,
  grounding: null,
  createdAt: '2026-06-19T10:00:00.000Z',
  feedback: {
    upCount: 0,
    downCount: 0,
    latestDownUpdatedAt: null,
    comments: [],
  },
  triage: {
    state: 'open',
    version: 0,
    resolution: null,
    legacyReason: null,
    closedAt: null,
    updatedAt: null,
  },
  verification: null,
  ...overrides,
})

const commentedQualityTurn = (overrides: Record<string, unknown> = {}) =>
  qualityTurn({
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

let container: HTMLDivElement
let root: Root
const observed = { current: 0 }

function Probe({
  baselineKeys,
  enabled,
  onChange,
}: {
  baselineKeys: readonly string[] | null
  enabled: boolean
  onChange: (newItemCount: number) => void
}) {
  const newItemCount = useNeedsAttentionActivity({
    baselineKeys,
    enabled,
    intervalMs: INTERVAL,
    backgroundIntervalMs: BACKGROUND_INTERVAL,
  })
  useEffect(() => {
    onChange(newItemCount)
  }, [newItemCount, onChange])
  return null
}

function DefaultCadenceProbe({ baselineKeys }: { baselineKeys: readonly string[] | null }) {
  useNeedsAttentionActivity({ baselineKeys })
  return null
}

const renderProbe = (
  baselineKeys: readonly string[] | null,
  enabled = true,
) => {
  act(() => {
    root.render(
      <Probe
        baselineKeys={baselineKeys}
        enabled={enabled}
        onChange={(value) => {
          observed.current = value
        }}
      />,
    )
  })
}

const renderDefaultCadenceProbe = (baselineKeys: readonly string[] | null) => {
  act(() => {
    root.render(<DefaultCadenceProbe baselineKeys={baselineKeys} />)
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

  it('counts written feedback that arrives after the displayed baseline', async () => {
    const decisions = [decisionSummary()]
    const conversations = [conversationSummary()]
    const baselineQuality = [commentedQualityTurn({ assistantMessageId: 'quality-1' })]
    mockInbox(decisions, conversations)
    qualityApiMock.listTurns.mockResolvedValue({
      items: [...baselineQuality, commentedQualityTurn({
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
    )
    await advanceOnePoll()

    expect(observed.current).toBe(1)
  })

  it('does not count an automatic quality signal as new operator activity', async () => {
    mockInbox([], [])
    qualityApiMock.listTurns.mockResolvedValue({
      items: [qualityTurn({ assistantMessageId: 'automatic-no-context' })],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never)

    renderProbe([])
    await advanceOnePoll()

    expect(observed.current).toBe(0)
  })

  it('counts a newly written down-vote comment as fresh activity', async () => {
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
    const displayedQuality = [commentedQualityTurn({ assistantMessageId: 'quality-1' })]
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
    )
    await advanceOnePoll()
    expect(observed.current).toBe(0)

    renderProbe(
      inboxItemKeys(asDecisions(decisions), asConversations(conversations), []),
      true,
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
      items: [commentedQualityTurn()],
      total: 1,
      page: 1,
      pageSize: 25,
      totalPages: 1,
    } as never)

    renderProbe(inboxItemKeys([], asConversations(conversations), []), true)
    await advanceOnePoll()

    expect(observed.current).toBe(1)
  })

  it('polls only written feedback for new actionable activity', async () => {
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

    expect(qualityApiMock.listTurns).toHaveBeenCalledTimes(1)
    expect(qualityApiMock.listTurns).toHaveBeenNthCalledWith(1, {
      feedback: ['down'],
      sort: 'negative_feedback_updated_at',
      activeNegativeFeedbackOnly: true,
      hasComment: true,
      limit: 25,
    })
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
    expect(chatApiMock.listChatHistory).toHaveBeenCalledTimes(1)
  })

  it('refreshes the new-item count from matching workspace hints without changing the displayed baseline', async () => {
    const displayedDecisions = [decisionSummary({ handle: 'decision-1' })]
    const displayedConversations = [conversationSummary()]
    const baseline = inboxItemKeys(
      asDecisions(displayedDecisions),
      asConversations(displayedConversations),
      [],
    )
    mockInbox(
      [
        ...displayedDecisions,
        decisionSummary({ handle: 'decision-2' }),
      ],
      displayedConversations,
    )

    renderProbe(baseline)
    expect(hitlApiMock.listPendingDecisions).not.toHaveBeenCalled()
    expect(useWorkspaceEventsOptionalMock).toHaveBeenLastCalledWith(
      [
        'hitl.decision_created',
        'hitl.decision_resolved',
        'conversation.ownership_changed',
        'quality.feedback_changed',
        'quality.triage_changed',
      ],
      expect.any(Function),
    )

    const onInvalidate = useWorkspaceEventsOptionalMock.mock.calls.at(-1)?.[1]
    await act(async () => {
      onInvalidate?.()
      await Promise.resolve()
    })

    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
    expect(observed.current).toBe(1)
    expect(baseline).toEqual(inboxItemKeys(
      asDecisions(displayedDecisions),
      asConversations(displayedConversations),
      [],
    ))
  })

  it('retains a 60 second reconcile floor by default', async () => {
    mockInbox([], [])
    renderDefaultCadenceProbe([])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999)
    })
    expect(hitlApiMock.listPendingDecisions).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
  })
})
