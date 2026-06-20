/* @vitest-environment jsdom */

import { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNeedsAttentionActivity } from '@/hooks/use-needs-attention-activity'
import { chatApi } from '@/lib/api'
import { hitlApi } from '@/lib/api-hitl'
import type { PendingApprovalDecision } from '@/lib/api-types'
import { inboxItemKeys, type HumanOwnedConversationSummary } from '@/lib/needs-attention'

const asDecisions = (decisions: unknown[]) => decisions as unknown as PendingApprovalDecision[]
const asConversations = (conversations: unknown[]) =>
  conversations as unknown as HumanOwnedConversationSummary[]

vi.mock('@/lib/api', () => ({
  chatApi: { listChatHistory: vi.fn() },
}))

vi.mock('@/lib/api-hitl', () => ({
  hitlApi: { listPendingDecisions: vi.fn() },
}))

const chatApiMock = vi.mocked(chatApi)
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

const renderProbe = (baselineKeys: readonly string[] | null, enabled = true) => {
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

    renderProbe(inboxItemKeys(asDecisions(decisions), asConversations(conversations)))
    await advanceOnePoll()

    expect(observed.current).toBe(0)
  })

  it('counts fresh approvals that appear after the baseline', async () => {
    const conversations = [conversationSummary()]
    const baseline = inboxItemKeys(asDecisions([decisionSummary({ handle: 'decision-1' })]), asConversations(conversations))

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
    renderProbe(inboxItemKeys(asDecisions([decisionSummary()]), asConversations([conversationSummary()])))

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
    const baseline = inboxItemKeys(asDecisions([decisionSummary({ handle: 'decision-1' })]), asConversations(conversations))
    mockInbox([decisionSummary({ handle: 'decision-1' }), decisionSummary({ handle: 'decision-2' })], conversations)

    renderProbe(baseline)
    becomeHidden()
    await advanceOnePoll()
    expect(hitlApiMock.listPendingDecisions).not.toHaveBeenCalled()

    await becomeVisible()

    expect(hitlApiMock.listPendingDecisions).toHaveBeenCalledTimes(1)
    expect(observed.current).toBe(1)
  })
})
